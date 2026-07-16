-- V8 Event Platform — complete schema setup
-- Generated from supabase/migrations/0001..0016 (in order).
-- HOW TO USE: Supabase Dashboard -> SQL Editor -> New query -> paste this
-- entire file -> Run. Safe to run once on an empty database.


-- ============================================================================
-- supabase/migrations/0001_roles.sql
-- ============================================================================
-- 0001_roles.sql
-- Tenant application role. Non-superuser, non-owner => Row-Level Security is
-- actually enforced against it. Mirrors Supabase's `authenticated` role.
-- Idempotent: roles are cluster-global and survive database drops.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    -- LOGIN + trust auth in the local test cluster. In Supabase this maps to
    -- the `authenticated` role reached through PostgREST/JWT.
    create role app_user login;
  end if;
end $$;

grant usage on schema public to app_user;

-- ============================================================================
-- supabase/migrations/0002_tenancy.sql
-- ============================================================================
-- 0002_tenancy.sql
-- The tenant. Every other table carries org_id and is isolated by RLS on it.

create table org (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

-- The tenant context for the current DB session. Set per-transaction via
--   select set_config('app.current_org', '<uuid>', false);
-- Returns NULL when unset so RLS predicates simply match no rows (deny closed)
-- rather than erroring.
create or replace function current_org() returns uuid
  language sql stable
  -- pin search_path so the custom GUC name can't be shadowed
  set search_path = pg_catalog
as $$
  select nullif(current_setting('app.current_org', true), '')::uuid
$$;

grant execute on function current_org() to app_user;

-- ============================================================================
-- supabase/migrations/0003_party.sql
-- ============================================================================
-- 0003_party.sql
-- Party = one identity per human/org, scoped to the org (outlives events).
-- person vs org is a column; representation (person acts for org) is a relation.

create type party_kind as enum ('person', 'org');

create table party (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references org(id),
  kind         party_kind not null,
  display_name text not null,
  email        text,
  -- Merge is a POINTER, never a rewrite of ledger rows. Absorbed party points
  -- at the survivor; reporting resolves through the chain. Reversible.
  merged_into  uuid references party(id),
  created_at   timestamptz not null default now(),
  -- a party cannot be merged into a party from another org
  constraint merged_into_same_org check (merged_into is null or merged_into <> id)
);

create index party_org_idx on party(org_id);
create index party_merged_into_idx on party(merged_into) where merged_into is not null;

-- Resolve a party through the merge chain to its surviving root.
create or replace function resolve_party(p_id uuid) returns uuid
  language plpgsql stable
as $$
declare
  cur uuid := p_id;
  nxt uuid;
  hops int := 0;
begin
  loop
    select merged_into into nxt from party where id = cur;
    if nxt is null then return cur; end if;
    cur := nxt;
    hops := hops + 1;
    if hops > 64 then
      raise exception 'party merge chain too deep or cyclic starting at %', p_id;
    end if;
  end loop;
end $$;

grant execute on function resolve_party(uuid) to app_user;

-- A person (agent) may act on behalf of another party (principal, e.g. an org).
-- The ledger names the PRINCIPAL (obligor); the agent is recorded on the txn.
create table party_representation (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references org(id),
  agent_party_id     uuid not null references party(id),
  principal_party_id uuid not null references party(id),
  effective_from     timestamptz not null default now(),
  effective_to       timestamptz,
  created_at         timestamptz not null default now(),
  constraint rep_distinct check (agent_party_id <> principal_party_id)
);

create index party_rep_org_idx on party_representation(org_id);

-- ============================================================================
-- supabase/migrations/0004_event_role.sql
-- ============================================================================
-- 0004_event_role.sql
-- Events, the role-at-event junction (the abstraction competitors can't express),
-- and lots (a consignor's item that gets sold to a buyer).

create table event (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references org(id),
  name       text not null,
  starts_at  timestamptz,
  created_at timestamptz not null default now()
);
create index event_org_idx on event(org_id);

-- Closed vocabulary (assumption A1). A party holds N roles at one event => N rows.
create type event_role as enum (
  'registrant', 'sponsor', 'bidder', 'buyer', 'consignor', 'donor'
);

create table role_at_event (
  id        uuid primary key default gen_random_uuid(),
  org_id    uuid not null references org(id),
  event_id  uuid not null references event(id),
  party_id  uuid not null references party(id),
  role      event_role not null,
  created_at timestamptz not null default now(),
  unique (org_id, event_id, party_id, role)
);
create index role_at_event_org_idx on role_at_event(org_id);
create index role_at_event_lookup_idx on role_at_event(event_id, party_id);

create table lot (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references org(id),
  event_id            uuid not null references event(id),
  consignor_party_id  uuid not null references party(id),
  label               text,
  created_at          timestamptz not null default now()
);
create index lot_org_idx on lot(org_id);

-- ============================================================================
-- supabase/migrations/0005_rates.sql
-- ============================================================================
-- 0005_rates.sql
-- Versioned, effective-dated rates. Never global config, never mutated: a change
-- is a NEW schedule with a later effective_at. Percentages are integer basis
-- points (1% = 100 bps) — no floats near money.
-- General enough for flat, tiered-by-hammer-band, and per-consignor override
-- (assumption A2). Buyer's premium is event-level (consignor_party_id IS NULL);
-- seller's commission may be overridden per consignor.

create type rate_kind as enum ('buyers_premium', 'sellers_commission');

create table rate_schedule (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references org(id),
  event_id           uuid not null references event(id),
  kind               rate_kind not null,
  consignor_party_id uuid references party(id),   -- NULL = event default
  effective_at       timestamptz not null,
  created_at         timestamptz not null default now()
);
create index rate_schedule_org_idx on rate_schedule(org_id);
create index rate_schedule_resolve_idx
  on rate_schedule(event_id, kind, effective_at);

create table rate_tier (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references org(id),
  rate_schedule_id  uuid not null references rate_schedule(id),
  lower_bound_cents bigint not null default 0,    -- band applies when hammer >= this
  rate_bps          integer not null,             -- basis points
  constraint rate_bps_sane check (rate_bps >= 0 and rate_bps <= 100000),
  constraint lower_bound_nonneg check (lower_bound_cents >= 0)
);
create index rate_tier_schedule_idx on rate_tier(rate_schedule_id);

-- Half-up rounding in integer cents. amount_cents and bps are non-negative here
-- (hammer >= 0), so integer division truncates == floor, and +5000 => round half
-- up at the 1/10000 place. bigint throughout to avoid overflow.
create or replace function round_half_up_bps(amount_cents bigint, bps integer)
  returns bigint language sql immutable
as $$
  select (amount_cents * bps + 5000) / 10000
$$;
grant execute on function round_half_up_bps(bigint, integer) to app_user;

-- Resolve the applicable rate: most specific schedule (consignor override beats
-- event default), most recent one effective at/-before as_of, then the tier band
-- for the hammer amount. Returns 0 when nothing is configured.
create or replace function resolve_rate_bps(
  p_event_id uuid,
  p_kind rate_kind,
  p_consignor_party_id uuid,
  p_hammer_cents bigint,
  p_as_of timestamptz
) returns integer
  language plpgsql stable
as $$
declare
  v_schedule uuid;
  v_bps integer;
begin
  select id into v_schedule
  from rate_schedule
  where event_id = p_event_id
    and kind = p_kind
    and effective_at <= p_as_of
    and (consignor_party_id is null
         or consignor_party_id = p_consignor_party_id)
  order by (consignor_party_id is not null) desc,  -- prefer override
           effective_at desc                        -- newest version
  limit 1;

  if v_schedule is null then
    return 0;
  end if;

  select rate_bps into v_bps
  from rate_tier
  where rate_schedule_id = v_schedule
    and lower_bound_cents <= p_hammer_cents
  order by lower_bound_cents desc
  limit 1;

  return coalesce(v_bps, 0);
end $$;
grant execute on function resolve_rate_bps(uuid, rate_kind, uuid, bigint, timestamptz) to app_user;

-- ============================================================================
-- supabase/migrations/0006_ledger.sql
-- ============================================================================
-- 0006_ledger.sql
-- The ledger. Append-only, integer cents, idempotency-keyed. Every module writes
-- here; reporting reads here; nothing computes money elsewhere.

create type ledger_entry_type as enum (
  'hammer', 'buyers_premium', 'sellers_commission',
  'sponsorship', 'donation', 'payment', 'payout'
);
-- NOTE: there is deliberately NO 'reversal' type. A reversal INHERITS the type
-- and role of the entry it reverses and negates the amount, so every type- or
-- role-scoped projection nets automatically without special-casing.

create table ledger_entry (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references org(id),
  event_id        uuid not null references event(id),
  -- The OBLIGOR: whose money this is. For representation, the principal (org),
  -- never the human who tapped the card.
  party_id        uuid not null references party(id),
  role            event_role not null,          -- role the money moved under
  entry_type      ledger_entry_type not null,
  amount_cents    bigint not null,              -- signed integer cents; never float
  currency        text not null default 'usd',
  -- Deterministic, producer-constructed. UNIQUE at the DB level (below) so a
  -- duplicate Stripe webhook is physically incapable of double-writing.
  idempotency_key text not null,
  reverses_id     uuid references ledger_entry(id),  -- set on reversal rows
  acting_party_id uuid references party(id),         -- the human who acted
  source          text not null default 'operator', -- stripe | venue_hub | operator
  posted_at       timestamptz not null default now(),

  -- MONEY RULE 3: idempotency is unique and enforced at the DB level, per tenant.
  constraint ledger_idempotency_unique unique (org_id, idempotency_key)
);

create index ledger_party_idx on ledger_entry(org_id, event_id, party_id);
create index ledger_event_type_idx on ledger_entry(org_id, event_id, entry_type);
create index ledger_reverses_idx on ledger_entry(reverses_id) where reverses_id is not null;

-- MONEY RULE 2: append-only. Corrections are reversing entries, never updates.
-- Belt: trigger. Suspenders: no UPDATE/DELETE grant to app_user (0009).
create or replace function ledger_reject_mutation() returns trigger
  language plpgsql
as $$
begin
  raise exception 'ledger_entry is append-only; % is forbidden (use reverse_entry)', tg_op
    using errcode = 'raise_exception';
end $$;

create trigger ledger_entry_no_update
  before update on ledger_entry
  for each row execute function ledger_reject_mutation();

create trigger ledger_entry_no_delete
  before delete on ledger_entry
  for each row execute function ledger_reject_mutation();

-- ============================================================================
-- supabase/migrations/0007_money_functions.sql
-- ============================================================================
-- 0007_money_functions.sql
-- The only writers of money. SECURITY INVOKER: they run as the caller and are
-- subject to the caller's RLS, so they can only touch the caller's org.

-- Settle a lot award into the ledger. Posts four party-attributed entries:
--   buyer:     +hammer, +buyers_premium
--   consignor: +hammer, -sellers_commission
-- so buyer_invoice = Σ(buyer rows), consignor_payout = Σ(consignor rows),
-- operator_revenue = Σ premium + Σ commission. Idempotent on (lot) via keys:
-- calling it twice for the same lot is a physical no-op.
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
  from lot where id = p_lot_id;        -- RLS scopes this to v_org
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
end $$;
grant execute on function post_lot_award(uuid, uuid, bigint, timestamptz) to app_user;

-- Correct an entry by appending its reversal. Inherits type+role, negates amount.
-- Idempotent: the reversal's key is derived from the original, so a retried
-- reversal cannot double-reverse.
create or replace function reverse_entry(p_entry_id uuid, p_as_of timestamptz)
  returns void
  language plpgsql
as $$
declare
  r ledger_entry%rowtype;
begin
  select * into r from ledger_entry where id = p_entry_id;   -- RLS scopes to org
  if r.id is null then
    raise exception 'entry % not found in current org', p_entry_id;
  end if;

  insert into ledger_entry
    (org_id, event_id, party_id, role, entry_type, amount_cents, currency,
     idempotency_key, reverses_id, acting_party_id, source, posted_at)
  values
    (r.org_id, r.event_id, r.party_id, r.role, r.entry_type, -r.amount_cents, r.currency,
     'reverse:' || r.idempotency_key, r.id, r.acting_party_id, 'operator', p_as_of)
  on conflict (org_id, idempotency_key) do nothing;
end $$;
grant execute on function reverse_entry(uuid, timestamptz) to app_user;

-- ============================================================================
-- supabase/migrations/0008_projections.sql
-- ============================================================================
-- 0008_projections.sql
-- Settlement figures are PROJECTIONS over the ledger, never stored tables.
-- security_invoker=on is load-bearing: without it a view runs as its owner
-- (postgres, superuser) and silently bypasses RLS, leaking across tenants.

-- buyer invoice = Σ hammer + Σ buyers_premium  (all rows with role='buyer',
-- reversals included since they inherit role='buyer' with a negated amount).
create view v_buyer_invoice with (security_invoker = on) as
  select org_id, event_id, party_id,
         sum(amount_cents) as invoice_cents
  from ledger_entry
  where role = 'buyer'
  group by org_id, event_id, party_id;

-- consignor payout = Σ hammer − Σ sellers_commission (commission stored negative).
create view v_consignor_payout with (security_invoker = on) as
  select org_id, event_id, party_id,
         sum(amount_cents) as payout_cents
  from ledger_entry
  where role = 'consignor'
  group by org_id, event_id, party_id;

-- operator revenue / realized fees = Σ buyers_premium + Σ sellers_commission.
-- commission is stored negative, so subtract it. This is the single live billing
-- base, visible identically to operator and platform (money rule: realized fees).
create view v_operator_revenue with (security_invoker = on) as
  select org_id, event_id,
         coalesce(sum(amount_cents) filter (where entry_type = 'buyers_premium'), 0)
       - coalesce(sum(amount_cents) filter (where entry_type = 'sellers_commission'), 0)
           as realized_fee_cents
  from ledger_entry
  group by org_id, event_id;

grant select on v_buyer_invoice, v_consignor_payout, v_operator_revenue to app_user;

-- ============================================================================
-- supabase/migrations/0009_rls.sql
-- ============================================================================
-- 0009_rls.sql
-- Multi-tenancy is enforced at the ROW level in the database, not the app.
-- Every tenant table: RLS enabled + FORCED, single isolation policy on org_id,
-- and privileges granted to app_user. The ledger withholds UPDATE/DELETE.

-- org isolates on its own id.
alter table org enable row level security;
alter table org force row level security;
create policy org_isolation on org
  using (id = current_org())
  with check (id = current_org());
grant select on org to app_user;   -- INSERT only via create_org() (0010)

-- Helper: apply the standard org_id isolation policy + grants to a tenant table.
do $$
declare
  t text;
  mutable_tables text[] := array[
    'party', 'party_representation', 'event', 'role_at_event', 'lot',
    'rate_schedule', 'rate_tier'
  ];
begin
  foreach t in array mutable_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy %I on %I using (org_id = current_org()) with check (org_id = current_org())',
      t || '_isolation', t);
    execute format(
      'grant select, insert, update, delete on %I to app_user', t);
  end loop;
end $$;

-- Ledger: same isolation, but APPEND-ONLY — grant SELECT + INSERT only.
alter table ledger_entry enable row level security;
alter table ledger_entry force row level security;
create policy ledger_entry_isolation on ledger_entry
  using (org_id = current_org())
  with check (org_id = current_org());
grant select, insert on ledger_entry to app_user;
-- deliberately NO update/delete grant.

-- ============================================================================
-- supabase/migrations/0010_platform.sql
-- ============================================================================
-- 0010_platform.sql
-- Platform-level onboarding. Creating an operator is a ROW, never a fork or a
-- code change. SECURITY DEFINER so it runs above tenant RLS to seed the org;
-- this is the SAME path that creates org #1 and org #500.

create or replace function create_org(p_name text) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into org (id, name) values (v_id, p_name);
  return v_id;
end $$;

grant execute on function create_org(text) to app_user;

-- ============================================================================
-- supabase/migrations/0011_stripe.sql
-- ============================================================================
-- 0011_stripe.sql
-- Operator-owned Stripe Connect config + raw webhook audit/dedupe log.
-- We never touch funds: charges are destination charges on the operator's own
-- connected account; the platform only ever receives the application fee.

create table stripe_account (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references org(id),
  stripe_account_id text not null,               -- acct_... (operator-owned)
  charges_enabled   boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (org_id)                                -- one connected account per org
);
create index stripe_account_org_idx on stripe_account(org_id);

-- Every webhook we accept is recorded here first. UNIQUE(org_id, stripe_event_id)
-- makes a redelivered event a no-op at ingestion, before any money is booked.
create table stripe_event (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references org(id),
  stripe_event_id  text not null,               -- evt_... (globally unique in Stripe)
  type             text not null,
  payload          jsonb not null,
  received_at      timestamptz not null default now(),
  unique (org_id, stripe_event_id)
);
create index stripe_event_org_idx on stripe_event(org_id);

-- RLS: same tenant isolation as every other table.
alter table stripe_account enable row level security;
alter table stripe_account force row level security;
create policy stripe_account_isolation on stripe_account
  using (org_id = current_org()) with check (org_id = current_org());
grant select, insert, update, delete on stripe_account to app_user;

alter table stripe_event enable row level security;
alter table stripe_event force row level security;
create policy stripe_event_isolation on stripe_event
  using (org_id = current_org()) with check (org_id = current_org());
grant select, insert on stripe_event to app_user;

-- ============================================================================
-- supabase/migrations/0012_payments.sql
-- ============================================================================
-- 0012_payments.sql
-- Payments and payouts as ledger entries, reconciliation views, and the
-- application-fee billing-base audit. Payments/payouts REDUCE what is owed, so
-- they are stored as negative amounts under the obligor's role.

-- Stripe-specific metadata for a collection (the ledger holds the money; this
-- holds the audit trail + the application fee we bill on).
create table payment (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references org(id),
  event_id                 uuid not null references event(id),
  party_id                 uuid not null references party(id),   -- the buyer
  stripe_payment_intent_id text,
  destination_account      text,                                 -- operator acct
  amount_cents             bigint not null,
  application_fee_cents    bigint not null default 0,
  idempotency_key          text not null,
  ledger_entry_id          uuid references ledger_entry(id),
  created_at               timestamptz not null default now(),
  unique (org_id, idempotency_key)
);
create index payment_org_idx on payment(org_id);
create index payment_event_party_idx on payment(org_id, event_id, party_id);

alter table payment enable row level security;
alter table payment force row level security;
create policy payment_isolation on payment
  using (org_id = current_org()) with check (org_id = current_org());
grant select, insert on payment to app_user;

-- Book a buyer collection. Refuses an org with no connected account (we never
-- collect without the operator's own Stripe behind it). Idempotent on the key.
create or replace function record_payment(
  p_buyer_party_id uuid,
  p_event_id uuid,
  p_amount_cents bigint,
  p_application_fee_cents bigint,
  p_payment_intent_id text,
  p_destination text,
  p_idempotency_key text,
  p_as_of timestamptz
) returns uuid
  language plpgsql
as $$
declare
  v_org uuid := current_org();
  v_ledger_id uuid;
begin
  if v_org is null then
    raise exception 'no tenant context (app.current_org unset)';
  end if;
  if not exists (select 1 from stripe_account where org_id = v_org) then
    raise exception 'org % has no Stripe Connect account; cannot collect funds', v_org
      using errcode = 'raise_exception';
  end if;

  insert into ledger_entry
    (org_id, event_id, party_id, role, entry_type, amount_cents, idempotency_key, source, posted_at)
  values
    (v_org, p_event_id, p_buyer_party_id, 'buyer', 'payment', -p_amount_cents, p_idempotency_key, 'stripe', p_as_of)
  on conflict (org_id, idempotency_key) do nothing
  returning id into v_ledger_id;

  -- Only record the metadata row on the fresh write (v_ledger_id set); a
  -- redelivery leaves both the ledger and the payment table untouched.
  if v_ledger_id is not null then
    insert into payment
      (org_id, event_id, party_id, stripe_payment_intent_id, destination_account,
       amount_cents, application_fee_cents, idempotency_key, ledger_entry_id)
    values
      (v_org, p_event_id, p_buyer_party_id, p_payment_intent_id, p_destination,
       p_amount_cents, p_application_fee_cents, p_idempotency_key, v_ledger_id)
    on conflict (org_id, idempotency_key) do nothing;
  end if;

  return v_ledger_id;
end $$;
grant execute on function record_payment(uuid, uuid, bigint, bigint, text, text, text, timestamptz) to app_user;

-- Book a consignor payout (money leaving the operator's balance to the consignor).
create or replace function record_payout(
  p_consignor_party_id uuid,
  p_event_id uuid,
  p_amount_cents bigint,
  p_idempotency_key text,
  p_as_of timestamptz
) returns uuid
  language plpgsql
as $$
declare
  v_org uuid := current_org();
  v_ledger_id uuid;
begin
  if v_org is null then
    raise exception 'no tenant context (app.current_org unset)';
  end if;
  if not exists (select 1 from stripe_account where org_id = v_org) then
    raise exception 'org % has no Stripe Connect account; cannot pay out', v_org
      using errcode = 'raise_exception';
  end if;

  insert into ledger_entry
    (org_id, event_id, party_id, role, entry_type, amount_cents, idempotency_key, source, posted_at)
  values
    (v_org, p_event_id, p_consignor_party_id, 'consignor', 'payout', -p_amount_cents, p_idempotency_key, 'stripe', p_as_of)
  on conflict (org_id, idempotency_key) do nothing
  returning id into v_ledger_id;

  return v_ledger_id;
end $$;
grant execute on function record_payout(uuid, uuid, bigint, text, timestamptz) to app_user;

-- Redefine the gross projections to charge/settlement types only, so they stay
-- "what is owed" once payment/payout entries exist. Balances live in the account
-- views below. (Phase 1 tests are unaffected: no payments present there.)
create or replace view v_buyer_invoice with (security_invoker = on) as
  select org_id, event_id, party_id,
         sum(amount_cents) as invoice_cents
  from ledger_entry
  where role = 'buyer' and entry_type in ('hammer', 'buyers_premium')
  group by org_id, event_id, party_id;

create or replace view v_consignor_payout with (security_invoker = on) as
  select org_id, event_id, party_id,
         sum(amount_cents) as payout_cents
  from ledger_entry
  where role = 'consignor' and entry_type in ('hammer', 'sellers_commission')
  group by org_id, event_id, party_id;

-- Buyer account: invoice (owed) − paid = balance.
create view v_buyer_account with (security_invoker = on) as
  select inv.org_id, inv.event_id, inv.party_id,
         inv.invoice_cents,
         coalesce(-pay.pay_sum, 0) as paid_cents,
         inv.invoice_cents + coalesce(pay.pay_sum, 0) as balance_cents
  from v_buyer_invoice inv
  left join (
    select org_id, event_id, party_id, sum(amount_cents) as pay_sum
    from ledger_entry
    where role = 'buyer' and entry_type = 'payment'
    group by org_id, event_id, party_id
  ) pay on pay.org_id = inv.org_id and pay.event_id = inv.event_id and pay.party_id = inv.party_id;

-- Consignor account: owed − paid = balance.
create view v_consignor_account with (security_invoker = on) as
  select owed.org_id, owed.event_id, owed.party_id,
         owed.payout_cents as owed_cents,
         coalesce(-po.po_sum, 0) as paid_cents,
         owed.payout_cents + coalesce(po.po_sum, 0) as balance_cents
  from v_consignor_payout owed
  left join (
    select org_id, event_id, party_id, sum(amount_cents) as po_sum
    from ledger_entry
    where role = 'consignor' and entry_type = 'payout'
    group by org_id, event_id, party_id
  ) po on po.org_id = owed.org_id and po.event_id = owed.event_id and po.party_id = owed.party_id;

-- Billing base audit: realized ledger fee vs. application fee actually collected.
-- delta must be zero; a non-zero delta is a billing discrepancy either party can
-- see. Both figures are live over the append-only ledger.
create view v_platform_billing with (security_invoker = on) as
  select rev.org_id, rev.event_id,
         rev.realized_fee_cents,
         coalesce(af.fee_collected, 0) as application_fee_collected_cents,
         rev.realized_fee_cents - coalesce(af.fee_collected, 0) as delta_cents
  from v_operator_revenue rev
  left join (
    select org_id, event_id, sum(application_fee_cents) as fee_collected
    from payment
    group by org_id, event_id
  ) af on af.org_id = rev.org_id and af.event_id = rev.event_id;

grant select on v_buyer_account, v_consignor_account, v_platform_billing to app_user;

-- ============================================================================
-- supabase/migrations/0013_fundraising.sql
-- ============================================================================
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

  -- Winning a lot makes the party a buyer at the event; the consignor holds the
  -- consignor role. These make the multi-role model visible and queryable.
  insert into role_at_event (org_id, event_id, party_id, role)
  values (v_org, v_event, p_buyer_party_id, 'buyer'),
         (v_org, v_event, v_consignor, 'consignor')
  on conflict (org_id, event_id, party_id, role) do nothing;
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

-- ============================================================================
-- supabase/migrations/0014_receipts.sql
-- ============================================================================
-- 0014_receipts.sql
-- Consolidated donor tax receipts across every role a party holds — the query no
-- competitor's split data model can write. Deductible = paid − FMV of benefits,
-- floored PER LINE (a bargain on one item cannot erase another's deductibility).

create view v_tax_receipt_line with (security_invoker = on) as
  -- sponsorships (quid pro quo: benefit FMV reduces deductibility)
  select org_id, event_id, sponsor_party_id as party_id,
         'sponsorship'::text as source_type,
         amount_cents as gross_cents,
         benefit_fmv_cents as fmv_cents,
         greatest(amount_cents - benefit_fmv_cents, 0) as deductible_cents
  from sponsorship
  union all
  -- donations (pure gift: fully deductible)
  select org_id, event_id, donor_party_id,
         'donation', amount_cents, 0::bigint, amount_cents
  from donation
  union all
  -- auction purchases (deductible = total paid − item FMV)
  select la.org_id, l.event_id, la.buyer_party_id,
         'auction',
         (la.hammer_cents + la.buyers_premium_cents) as gross_cents,
         l.fmv_cents as fmv_cents,
         greatest(la.hammer_cents + la.buyers_premium_cents - l.fmv_cents, 0) as deductible_cents
  from lot_award la
  join lot l on l.id = la.lot_id and l.org_id = la.org_id;

grant select on v_tax_receipt_line to app_user;

-- One consolidated receipt row per party per event.
-- requires_quid_pro_quo_disclosure: IRS requires a written statement of the
-- deductible amount for any contribution over $75 where goods/services were given.
create view v_donor_tax_receipt with (security_invoker = on) as
  select org_id, event_id, party_id,
         sum(gross_cents) as gross_cents,
         sum(fmv_cents) as fmv_cents,
         sum(deductible_cents) as deductible_cents,
         count(*)::int as line_count,
         bool_or(fmv_cents > 0 and gross_cents > 7500) as requires_quid_pro_quo_disclosure
  from v_tax_receipt_line
  group by org_id, event_id, party_id;

grant select on v_donor_tax_receipt to app_user;

-- ============================================================================
-- supabase/migrations/0015_offline.sql
-- ============================================================================
-- 0015_offline.sql
-- Offline venue hub machinery: the replayable monotonic-sequence op queue, the
-- FIXED conflict policy (bids append-only; registrations last-write-wins), and
-- the per-device cursor that makes replay idempotent and gaps loud.
--
-- The same schema runs on the venue hub (NUC) and in the cloud; sync in either
-- direction is "replay the other side's outbox" (src/hub/sync.ts).

-- Generic append-only guard (reusable; ledger has its own with the same shape).
create or replace function reject_mutation() returns trigger
  language plpgsql
as $$
begin
  raise exception '% is append-only; % is forbidden', tg_table_name, tg_op
    using errcode = 'raise_exception';
end $$;

-- ---------------------------------------------------------------------------
-- Registrations: last-write-wins on (org, event, party).
-- Winner = greatest (updated_at, source_device_id); the device-id tiebreak makes
-- convergence order-independent when timestamps collide.
create table registration (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references org(id),
  event_id         uuid not null references event(id),
  party_id         uuid not null references party(id),
  status           text not null default 'registered',
  updated_at       timestamptz not null,
  source_device_id text not null,
  unique (org_id, event_id, party_id)
);
create index registration_org_idx on registration(org_id);

alter table registration enable row level security;
alter table registration force row level security;
create policy registration_isolation on registration
  using (org_id = current_org()) with check (org_id = current_org());
grant select, insert, update on registration to app_user;  -- LWW upserts; no delete

-- ---------------------------------------------------------------------------
-- Bids: APPEND-ONLY. Never merge. Never drop. A bid is an intent, not money —
-- it reaches the ledger only via post_lot_award — but it gets ledger discipline:
-- integer cents, no UPDATE/DELETE (trigger + grants), and a natural idempotency
-- key (org_id, device_id, device_seq).
create table bid (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references org(id),
  event_id         uuid not null references event(id),
  lot_id           uuid not null references lot(id),
  bidder_party_id  uuid not null references party(id),
  amount_cents     bigint not null check (amount_cents >= 0),
  device_id        text not null,
  device_seq       bigint not null,
  placed_at        timestamptz not null,
  unique (org_id, device_id, device_seq)
);
create index bid_org_idx on bid(org_id);
create index bid_lot_idx on bid(org_id, lot_id, amount_cents desc);

create trigger bid_no_update before update on bid
  for each row execute function reject_mutation();
create trigger bid_no_delete before delete on bid
  for each row execute function reject_mutation();

alter table bid enable row level security;
alter table bid force row level security;
create policy bid_isolation on bid
  using (org_id = current_org()) with check (org_id = current_org());
grant select, insert on bid to app_user;   -- deliberately NO update/delete

-- ---------------------------------------------------------------------------
-- The op queue. Every offline-capable mutation is an op recorded here in the
-- SAME transaction that applies it locally, so the queue can never disagree
-- with local state. Append-only; UNIQUE per (org, device, seq).
create table sync_outbox (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references org(id),
  device_id   text not null,
  device_seq  bigint not null,
  op_type     text not null,
  payload     jsonb not null,
  recorded_at timestamptz not null default now(),
  unique (org_id, device_id, device_seq)
);
create index sync_outbox_org_idx on sync_outbox(org_id);

create trigger sync_outbox_no_update before update on sync_outbox
  for each row execute function reject_mutation();
create trigger sync_outbox_no_delete before delete on sync_outbox
  for each row execute function reject_mutation();

alter table sync_outbox enable row level security;
alter table sync_outbox force row level security;
create policy sync_outbox_isolation on sync_outbox
  using (org_id = current_org()) with check (org_id = current_org());
grant select, insert on sync_outbox to app_user;

-- Per-device high-water mark on the APPLYING side. Guarantees:
--   seq <= last_seq      -> duplicate (no-op; replay is idempotent)
--   seq  = last_seq + 1  -> apply and advance
--   seq  > last_seq + 1  -> GAP: refuse loudly. Silence is how bids get lost.
create table sync_device_cursor (
  org_id     uuid not null references org(id),
  device_id  text not null,
  last_seq   bigint not null default 0,
  primary key (org_id, device_id)
);

alter table sync_device_cursor enable row level security;
alter table sync_device_cursor force row level security;
create policy sync_device_cursor_isolation on sync_device_cursor
  using (org_id = current_org()) with check (org_id = current_org());
grant select, insert, update on sync_device_cursor to app_user;

-- ---------------------------------------------------------------------------
-- Apply one op. SECURITY INVOKER: runs under the caller's RLS.
-- Returns 'applied' or 'duplicate'; raises on gaps and unknown op types.
create or replace function apply_sync_op(
  p_device_id text,
  p_device_seq bigint,
  p_op_type text,
  p_payload jsonb
) returns text
  language plpgsql
as $$
declare
  v_org  uuid := current_org();
  v_last bigint;
begin
  if v_org is null then
    raise exception 'no tenant context (app.current_org unset)';
  end if;

  insert into sync_device_cursor (org_id, device_id, last_seq)
  values (v_org, p_device_id, 0)
  on conflict (org_id, device_id) do nothing;

  select last_seq into v_last
  from sync_device_cursor
  where org_id = v_org and device_id = p_device_id
  for update;                         -- serialize appliers per device

  if p_device_seq <= v_last then
    return 'duplicate';
  end if;
  if p_device_seq > v_last + 1 then
    raise exception 'sequence gap for device %: got seq %, cursor at % (missing % .. %)',
      p_device_id, p_device_seq, v_last, v_last + 1, p_device_seq - 1
      using errcode = 'raise_exception';
  end if;

  if p_op_type = 'bid' then
    insert into bid
      (org_id, event_id, lot_id, bidder_party_id, amount_cents, device_id, device_seq, placed_at)
    values
      (v_org,
       (p_payload->>'event_id')::uuid,
       (p_payload->>'lot_id')::uuid,
       (p_payload->>'bidder_party_id')::uuid,
       (p_payload->>'amount_cents')::bigint,
       p_device_id, p_device_seq,
       (p_payload->>'placed_at')::timestamptz)
    on conflict (org_id, device_id, device_seq) do nothing;

    insert into role_at_event (org_id, event_id, party_id, role)
    values (v_org, (p_payload->>'event_id')::uuid, (p_payload->>'bidder_party_id')::uuid, 'bidder')
    on conflict (org_id, event_id, party_id, role) do nothing;

  elsif p_op_type = 'registration' then
    insert into registration (org_id, event_id, party_id, status, updated_at, source_device_id)
    values
      (v_org,
       (p_payload->>'event_id')::uuid,
       (p_payload->>'party_id')::uuid,
       p_payload->>'status',
       (p_payload->>'updated_at')::timestamptz,
       p_device_id)
    on conflict (org_id, event_id, party_id) do update
      set status = excluded.status,
          updated_at = excluded.updated_at,
          source_device_id = excluded.source_device_id
      where (excluded.updated_at, excluded.source_device_id)
          > (registration.updated_at, registration.source_device_id);

    insert into role_at_event (org_id, event_id, party_id, role)
    values (v_org, (p_payload->>'event_id')::uuid, (p_payload->>'party_id')::uuid, 'registrant')
    on conflict (org_id, event_id, party_id, role) do nothing;

  else
    raise exception 'unknown op_type: %', p_op_type;
  end if;

  update sync_device_cursor
  set last_seq = p_device_seq
  where org_id = v_org and device_id = p_device_id;

  return 'applied';
end $$;
grant execute on function apply_sync_op(text, bigint, text, jsonb) to app_user;

-- Originate an op locally: record it in the outbox AND apply it, atomically.
-- If apply raises (gap, bad payload), the outbox row rolls back with it — the
-- queue never contains an op the origin itself didn't accept.
create or replace function enqueue_op(
  p_device_id text,
  p_device_seq bigint,
  p_op_type text,
  p_payload jsonb
) returns text
  language plpgsql
as $$
declare
  v_org uuid := current_org();
begin
  if v_org is null then
    raise exception 'no tenant context (app.current_org unset)';
  end if;

  insert into sync_outbox (org_id, device_id, device_seq, op_type, payload)
  values (v_org, p_device_id, p_device_seq, p_op_type, p_payload)
  on conflict (org_id, device_id, device_seq) do nothing;

  return apply_sync_op(p_device_id, p_device_seq, p_op_type, p_payload);
end $$;
grant execute on function enqueue_op(text, bigint, text, jsonb) to app_user;

-- ============================================================================
-- supabase/migrations/0016_auth.sql
-- ============================================================================
-- 0016_auth.sql
-- Supabase Auth + JWT-native tenancy, without breaking the GUC model the tests
-- and local dev rely on. current_org() now resolves from three sources in order:
--   1. app.current_org GUC          (explicit; tests + server-derived context)
--   2. request.jwt.claims ->> org_id (a Supabase Auth JWT with an org claim)
--   3. the signed-in user's membership (auth.uid())
-- The GUC keeps top priority, so every prior test and the local demo are
-- unaffected. This migration is idempotent and safe to run on Supabase, where
-- the auth schema, roles, and auth.uid() already exist and are left untouched.

-- ---------------------------------------------------------------------------
-- Supabase compatibility shim. Create these ONLY if absent, so on Supabase the
-- real objects win and locally we get stubs the schema can reference.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
end $$;

create schema if not exists auth;

-- auth.uid(): the current JWT subject. Supabase ships this; stub it locally.
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $create$
      create function auth.uid() returns uuid language sql stable as $body$
        select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
      $body$;
    $create$;
  end if;
end $$;

-- auth.jwt(): the current JWT claims as jsonb. Supabase ships this; stub locally.
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'jwt'
  ) then
    execute $create$
      create function auth.jwt() returns jsonb language sql stable as $body$
        select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
      $body$;
    $create$;
  end if;
end $$;

-- auth.users: Supabase's user table. Stub (id only) locally; untouched on Supabase.
create table if not exists auth.users (id uuid primary key);

-- Local-stub environment only (no `supabase_admin` role): grant what Supabase
-- already grants on its auth schema, so `authenticated` can call auth.uid().
-- Skipped on Supabase (auth is already wired, and app_user isn't used there).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    grant usage on schema auth to authenticated, anon, app_user;
    grant execute on function auth.uid() to authenticated, anon, app_user;
    grant execute on function auth.jwt() to authenticated, anon, app_user;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Membership: which operator org(s) a user belongs to.
create table membership (
  user_id    uuid not null references auth.users(id) on delete cascade,
  org_id     uuid not null references org(id) on delete cascade,
  role       text not null default 'staff',   -- staff | admin | owner
  created_at timestamptz not null default now(),
  primary key (user_id, org_id)
);
create index membership_org_idx on membership(org_id);

alter table membership enable row level security;
alter table membership force row level security;
-- Isolated by USER, not org (a different axis than the other tenant tables): a
-- signed-in user reads only their own memberships.
create policy membership_self on membership
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
grant select on membership to authenticated;

-- ---------------------------------------------------------------------------
-- Server-side org resolution. SECURITY DEFINER so it bypasses membership RLS
-- (the server is not the user). Given a VERIFIED session user id, return their
-- org. app_user only — the server derives tenant context from the trusted
-- session, never from client input.
create or replace function resolve_user_org(p_user_id uuid) returns uuid
  language sql stable security definer set search_path = public
as $$
  select org_id from membership where user_id = p_user_id order by created_at limit 1
$$;
revoke all on function resolve_user_org(uuid) from public;
grant execute on function resolve_user_org(uuid) to app_user;

-- Membership check for the server (app_user can't see membership rows under its
-- user-axis RLS). SECURITY DEFINER; used to authorize a session against an org.
create or replace function is_member(p_user_id uuid, p_org_id uuid) returns boolean
  language sql stable security definer set search_path = public
as $$
  select exists (select 1 from membership where user_id = p_user_id and org_id = p_org_id)
$$;
revoke all on function is_member(uuid, uuid) from public;
grant execute on function is_member(uuid, uuid) to app_user;

-- The signed-in user's own org (auth.uid()); safe to expose to authenticated
-- because it can only ever resolve the caller's own membership. Used by
-- current_org() step 3 without recursing into membership RLS.
create or replace function current_user_org() returns uuid
  language sql stable security definer set search_path = public
as $$
  select org_id from membership where user_id = auth.uid() order by created_at limit 1
$$;
revoke all on function current_user_org() from public;
grant execute on function current_user_org() to authenticated, app_user;

-- Onboard a member. SECURITY DEFINER; server-only (NOT granted to authenticated,
-- or a signed-in user could add themselves to any org).
create or replace function add_member(p_user_id uuid, p_org_id uuid, p_role text default 'staff')
  returns void language sql security definer set search_path = public
as $$
  insert into membership (user_id, org_id, role) values (p_user_id, p_org_id, p_role)
  on conflict (user_id, org_id) do update set role = excluded.role
$$;
revoke all on function add_member(uuid, uuid, text) from public;
grant execute on function add_member(uuid, uuid, text) to app_user;

-- ---------------------------------------------------------------------------
-- The dual-source resolver. GUC > JWT claim > membership.
create or replace function current_org() returns uuid
  language plpgsql stable set search_path = public, pg_catalog
as $$
declare
  v_txt text;
  v_org uuid;
  v_uid uuid;
begin
  -- 1. explicit GUC (tests, server-derived context) — always wins
  v_txt := nullif(current_setting('app.current_org', true), '');
  if v_txt is not null then
    return v_txt::uuid;
  end if;

  -- 2. org_id claim on a Supabase Auth JWT
  begin
    v_txt := nullif(current_setting('request.jwt.claims', true), '');
    if v_txt is not null then
      v_org := (v_txt::jsonb ->> 'org_id')::uuid;
      if v_org is not null then
        return v_org;
      end if;
    end if;
  exception when others then
    -- malformed claims: ignore and fall through
    null;
  end;

  -- 3. the signed-in user's membership
  begin
    v_uid := auth.uid();
    if v_uid is not null then
      return current_user_org();
    end if;
  exception when others then
    null;
  end;

  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Mirror app_user's table/view privileges onto `authenticated`, so the same RLS
-- policies (org_id = current_org()) serve PostgREST/client access on Supabase.
-- INSERT/UPDATE/DELETE match app_user exactly (e.g. authenticated cannot
-- UPDATE/DELETE the ledger or bids, just like app_user).
do $$
declare r record;
begin
  for r in
    select table_name, privilege_type
    from information_schema.role_table_grants
    where grantee = 'app_user' and table_schema = 'public'
  loop
    execute format('grant %s on public.%I to authenticated', r.privilege_type, r.table_name);
  end loop;
end $$;

grant usage on schema public to authenticated;
grant execute on all functions in schema public to authenticated;
-- ...but never the privileged/platform functions.
revoke execute on function create_org(text) from authenticated;
revoke execute on function resolve_user_org(uuid) from authenticated;
revoke execute on function add_member(uuid, uuid, text) from authenticated;
