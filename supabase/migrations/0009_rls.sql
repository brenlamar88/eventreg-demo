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
