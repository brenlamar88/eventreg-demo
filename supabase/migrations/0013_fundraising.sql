-- 0013_fundraising.sql
-- Sponsorships, donations, per-lot FMV, and the buyer->lot award record.
-- Contributions are ledger entries; these tables carry the domain metadata
-- (benefit FMV, designation) that receipting needs.

-- Fair market value of an auction item (retail value), for donor deductibility.
alter table lot add column fmv_cents bigint not null default 0;

-- Denormalized award record: links buyer -> lot with the posted amounts, so
-- receipts can compute per-lot deductibility without parsing idempotency keys.
-- The ledger stays the money source of truth; a property test asserts these
-- amounts always equal the ledger's award entries.
create table lot_award (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references org(id),
  lot_id                  uuid not null references lot(id),
  buyer_party_id          uuid not null references party(id),
  hammer_cents            bigint not null,
  buyers_premium_cents    bigint not null,
  sellers_commission_cents bigint not null,   -- positive magnitude
  awarded_at              timestamptz not null default now(),
  unique (lot_id)
);
create index lot_award_org_idx on lot_award(org_id);

alter table lot_award enable row level security;
alter table lot_award force row level security;
create policy lot_award_isolation on lot_award
  using (org_id = current_org()) with check (org_id = current_org());
grant select, insert on lot_award to app_user;

-- Sponsorship level config (operator-editable), e.g. Gold / Silver.
create table sponsorship_level (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references org(id),
  event_id          uuid not null references event(id),
  name              text not null,
  amount_cents      bigint not null,
  benefit_fmv_cents bigint not null default 0,
  created_at        timestamptz not null default now()
);
create index sponsorship_level_org_idx on sponsorship_level(org_id);

alter table sponsorship_level enable row level security;
alter table sponsorship_level force row level security;
create policy sponsorship_level_isolation on sponsorship_level
  using (org_id = current_org()) with check (org_id = current_org());
grant select, insert, update, delete on sponsorship_level to app_user;

create table sponsorship (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references org(id),
  event_id          uuid not null references event(id),
  sponsor_party_id  uuid not null references party(id),
  amount_cents      bigint not null,
  benefit_fmv_cents bigint not null default 0,
  idempotency_key   text not null,
  ledger_entry_id   uuid references ledger_entry(id),
  committed_at      timestamptz not null default now(),
  unique (org_id, idempotency_key)
);
create index sponsorship_org_idx on sponsorship(org_id);
create index sponsorship_event_party_idx on sponsorship(org_id, event_id, sponsor_party_id);

alter table sponsorship enable row level security;
alter table sponsorship force row level security;
create policy sponsorship_isolation on sponsorship
  using (org_id = current_org()) with check (org_id = current_org());
grant select, insert on sponsorship to app_user;

create table donation (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references org(id),
  event_id        uuid not null references event(id),
  donor_party_id  uuid not null references party(id),
  amount_cents    bigint not null,
  designation     text,
  idempotency_key text not null,
  ledger_entry_id uuid references ledger_entry(id),
  received_at     timestamptz not null default now(),
  unique (org_id, idempotency_key)
);
create index donation_org_idx on donation(org_id);
create index donation_event_party_idx on donation(org_id, event_id, donor_party_id);

alter table donation enable row level security;
alter table donation force row level security;
create policy donation_isolation on donation
  using (org_id = current_org()) with check (org_id = current_org());
grant select, insert on donation to app_user;

-- Re-define post_lot_award to also write the lot_award record atomically with
-- the ledger entries (same computation, one transaction).
create or replace function post_lot_award(
  p_lot_id uuid,
  p_buyer_party_id uuid,
  p_hammer_cents bigint,
  p_as_of timestamptz
) returns void
  language plpgsql
as $$
declare
  v_org        uuid := current_org();
  v_event      uuid;
  v_consignor  uuid;
  v_premium_bps integer;
  v_commission_bps integer;
  v_premium    bigint;
  v_commission bigint;
  v_base       text;
begin
  if v_org is null then
    raise exception 'no tenant context (app.current_org unset)';
  end if;
  if p_hammer_cents < 0 then
    raise exception 'hammer must be non-negative, got %', p_hammer_cents;
  end if;

  select event_id, consignor_party_id
    into v_event, v_consignor
  from lot where id = p_lot_id;
  if v_event is null then
    raise exception 'lot % not found in current org', p_lot_id;
  end if;

  v_premium_bps    := resolve_rate_bps(v_event, 'buyers_premium', null, p_hammer_cents, p_as_of);
  v_commission_bps := resolve_rate_bps(v_event, 'sellers_commission', v_consignor, p_hammer_cents, p_as_of);
  v_premium    := round_half_up_bps(p_hammer_cents, v_premium_bps);
  v_commission := round_half_up_bps(p_hammer_cents, v_commission_bps);
  v_base := 'award:' || p_lot_id::text;

  insert into ledger_entry
    (org_id, event_id, party_id, role, entry_type, amount_cents, idempotency_key, acting_party_id, source, posted_at)
  values
    (v_org, v_event, p_buyer_party_id, 'buyer',     'hammer',             p_hammer_cents, v_base || ':buyer:hammer',      p_buyer_party_id, 'operator', p_as_of),
    (v_org, v_event, p_buyer_party_id, 'buyer',     'buyers_premium',     v_premium,      v_base || ':buyer:premium',     p_buyer_party_id, 'operator', p_as_of),
    (v_org, v_event, v_consignor,      'consignor', 'hammer',             p_hammer_cents, v_base || ':consignor:hammer',  p_buyer_party_id, 'operator', p_as_of),
    (v_org, v_event, v_consignor,      'consignor', 'sellers_commission', -v_commission,  v_base || ':consignor:commission', p_buyer_party_id, 'operator', p_as_of)
  on conflict (org_id, idempotency_key) do nothing;

  insert into lot_award
    (org_id, lot_id, buyer_party_id, hammer_cents, buyers_premium_cents, sellers_commission_cents, awarded_at)
  values
    (v_org, p_lot_id, p_buyer_party_id, p_hammer_cents, v_premium, v_commission, p_as_of)
  on conflict (lot_id) do nothing;
end $$;

-- Record a sponsorship commitment: ledger entry + metadata + sponsor role.
create or replace function record_sponsorship(
  p_event_id uuid,
  p_sponsor_party_id uuid,
  p_amount_cents bigint,
  p_benefit_fmv_cents bigint,
  p_idempotency_key text,
  p_as_of timestamptz
) returns uuid
  language plpgsql
as $$
declare
  v_org uuid := current_org();
  v_ledger_id uuid;
begin
  if v_org is null then raise exception 'no tenant context'; end if;

  insert into ledger_entry
    (org_id, event_id, party_id, role, entry_type, amount_cents, idempotency_key, source, posted_at)
  values
    (v_org, p_event_id, p_sponsor_party_id, 'sponsor', 'sponsorship', p_amount_cents,
     'sponsorship:' || p_idempotency_key, 'operator', p_as_of)
  on conflict (org_id, idempotency_key) do nothing
  returning id into v_ledger_id;

  if v_ledger_id is not null then
    insert into sponsorship
      (org_id, event_id, sponsor_party_id, amount_cents, benefit_fmv_cents, idempotency_key, ledger_entry_id)
    values
      (v_org, p_event_id, p_sponsor_party_id, p_amount_cents, p_benefit_fmv_cents, p_idempotency_key, v_ledger_id)
    on conflict (org_id, idempotency_key) do nothing;

    insert into role_at_event (org_id, event_id, party_id, role)
    values (v_org, p_event_id, p_sponsor_party_id, 'sponsor')
    on conflict (org_id, event_id, party_id, role) do nothing;
  end if;

  return v_ledger_id;
end $$;
grant execute on function record_sponsorship(uuid, uuid, bigint, bigint, text, timestamptz) to app_user;

-- Record a donation: ledger entry + metadata + donor role.
create or replace function record_donation(
  p_event_id uuid,
  p_donor_party_id uuid,
  p_amount_cents bigint,
  p_designation text,
  p_idempotency_key text,
  p_as_of timestamptz
) returns uuid
  language plpgsql
as $$
declare
  v_org uuid := current_org();
  v_ledger_id uuid;
begin
  if v_org is null then raise exception 'no tenant context'; end if;

  insert into ledger_entry
    (org_id, event_id, party_id, role, entry_type, amount_cents, idempotency_key, source, posted_at)
  values
    (v_org, p_event_id, p_donor_party_id, 'donor', 'donation', p_amount_cents,
     'donation:' || p_idempotency_key, 'operator', p_as_of)
  on conflict (org_id, idempotency_key) do nothing
  returning id into v_ledger_id;

  if v_ledger_id is not null then
    insert into donation
      (org_id, event_id, donor_party_id, amount_cents, designation, idempotency_key, ledger_entry_id)
    values
      (v_org, p_event_id, p_donor_party_id, p_amount_cents, p_designation, p_idempotency_key, v_ledger_id)
    on conflict (org_id, idempotency_key) do nothing;

    insert into role_at_event (org_id, event_id, party_id, role)
    values (v_org, p_event_id, p_donor_party_id, 'donor')
    on conflict (org_id, event_id, party_id, role) do nothing;
  end if;

  return v_ledger_id;
end $$;
grant execute on function record_donation(uuid, uuid, bigint, text, text, timestamptz) to app_user;
