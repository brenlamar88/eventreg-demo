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
