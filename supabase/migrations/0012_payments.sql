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
