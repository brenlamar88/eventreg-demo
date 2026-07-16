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
