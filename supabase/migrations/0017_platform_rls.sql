-- 0017_platform_rls.sql
-- Platform-role access under FORCE RLS, portable to Supabase.
--
-- Locally the admin connection is a real superuser, which bypasses RLS. On
-- Supabase the admin role (`postgres`) is NOT a superuser, and every tenant
-- table here uses FORCE ROW LEVEL SECURITY — which applies even to the table
-- owner. Consequence: SECURITY DEFINER platform functions (create_org,
-- add_member, resolve_user_org) and the open-mode platform screens (listOrgs +
-- v_platform_billing) fail with RLS violations, because they run with no
-- tenant context by design.
--
-- Fix: grant the MIGRATION-RUNNING role (captured as current_user at DDL time —
-- superuser postgres locally, non-superuser postgres on Supabase) an explicit
-- platform policy on every RLS table. Tenant roles (app_user, authenticated)
-- are untouched: policies are per-role, so their isolation policies remain the
-- only ones that apply to them. Append-only guarantees are unaffected — the
-- ledger/bid/outbox triggers reject UPDATE/DELETE regardless of role.

do $$
declare r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  loop
    execute format('drop policy if exists %I on %I', r.relname || '_platform', r.relname);
    execute format(
      'create policy %I on %I as permissive for all to %I using (true) with check (true)',
      r.relname || '_platform', r.relname, current_user
    );
  end loop;
end $$;
