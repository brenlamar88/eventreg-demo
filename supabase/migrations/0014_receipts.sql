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
