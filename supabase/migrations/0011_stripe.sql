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
