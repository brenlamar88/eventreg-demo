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
