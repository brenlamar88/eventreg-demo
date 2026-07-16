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
