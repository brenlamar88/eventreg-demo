-- 0001_roles.sql
-- Tenant application role. Non-superuser, non-owner => Row-Level Security is
-- actually enforced against it. Mirrors Supabase's `authenticated` role.
-- Idempotent: roles are cluster-global and survive database drops.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    -- LOGIN + trust auth in the local test cluster. In Supabase this maps to
    -- the `authenticated` role reached through PostgREST/JWT.
    create role app_user login;
  end if;
end $$;

grant usage on schema public to app_user;
