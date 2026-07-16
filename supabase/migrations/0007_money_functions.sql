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
