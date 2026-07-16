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
