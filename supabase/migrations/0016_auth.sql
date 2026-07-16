-- 0016_auth.sql
-- Supabase Auth + JWT-native tenancy, without breaking the GUC model the tests
-- and local dev rely on. current_org() now resolves from three sources in order:
--   1. app.current_org GUC          (explicit; tests + server-derived context)
--   2. request.jwt.claims ->> org_id (a Supabase Auth JWT with an org claim)
--   3. the signed-in user's membership (auth.uid())
-- The GUC keeps top priority, so every prior test and the local demo are
-- unaffected. This migration is idempotent and safe to run on Supabase, where
-- the auth schema, roles, and auth.uid() already exist and are left untouched.

-- ---------------------------------------------------------------------------
-- Supabase compatibility shim. Create these ONLY if absent, so on Supabase the
-- real objects win and locally we get stubs the schema can reference.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
end $$;

-- The auth schema: exists on Supabase (owned by supabase_auth_admin, where even
-- IF NOT EXISTS forms fail the ACL check before the existence check) — so test
-- the catalog first and only create when genuinely absent (local cluster).
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'auth') then
    create schema auth;
  end if;
end $$;

-- auth.uid(): the current JWT subject. Supabase ships this; stub it locally.
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $create$
      create function auth.uid() returns uuid language sql stable as $body$
        select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
      $body$;
    $create$;
  end if;
end $$;

-- auth.jwt(): the current JWT claims as jsonb. Supabase ships this; stub locally.
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'jwt'
  ) then
    execute $create$
      create function auth.jwt() returns jsonb language sql stable as $body$
        select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
      $body$;
    $create$;
  end if;
end $$;

-- auth.users: Supabase's user table. Stub (id only) locally; untouched on
-- Supabase. Must be catalog-guarded: `create table if not exists auth.users`
-- fails with "permission denied for schema auth" on Supabase because the ACL
-- check runs before the existence check.
do $$
begin
  if to_regclass('auth.users') is null then
    create table auth.users (id uuid primary key);
  end if;
end $$;

-- Local-stub environment only: if WE own the auth schema (we just created the
-- stub), wire the grants Supabase would normally provide, so `authenticated`
-- can call auth.uid(). On Supabase the schema is owned by supabase_auth_admin
-- (not us), so this is skipped and Supabase's own grants apply. Ownership is
-- the correct detector — role-name checks are brittle across environments.
do $$
declare v_owner name;
begin
  select pg_get_userbyid(nspowner) into v_owner from pg_namespace where nspname = 'auth';
  if v_owner = current_user then
    grant usage on schema auth to authenticated, anon, app_user;
    grant execute on function auth.uid() to authenticated, anon, app_user;
    grant execute on function auth.jwt() to authenticated, anon, app_user;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Membership: which operator org(s) a user belongs to.
create table membership (
  user_id    uuid not null references auth.users(id) on delete cascade,
  org_id     uuid not null references org(id) on delete cascade,
  role       text not null default 'staff',   -- staff | admin | owner
  created_at timestamptz not null default now(),
  primary key (user_id, org_id)
);
create index membership_org_idx on membership(org_id);

alter table membership enable row level security;
alter table membership force row level security;
-- Isolated by USER, not org (a different axis than the other tenant tables): a
-- signed-in user reads only their own memberships.
create policy membership_self on membership
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
grant select on membership to authenticated;

-- ---------------------------------------------------------------------------
-- Server-side org resolution. SECURITY DEFINER so it bypasses membership RLS
-- (the server is not the user). Given a VERIFIED session user id, return their
-- org. app_user only — the server derives tenant context from the trusted
-- session, never from client input.
create or replace function resolve_user_org(p_user_id uuid) returns uuid
  language sql stable security definer set search_path = public
as $$
  select org_id from membership where user_id = p_user_id order by created_at limit 1
$$;
revoke all on function resolve_user_org(uuid) from public;
grant execute on function resolve_user_org(uuid) to app_user;

-- Membership check for the server (app_user can't see membership rows under its
-- user-axis RLS). SECURITY DEFINER; used to authorize a session against an org.
create or replace function is_member(p_user_id uuid, p_org_id uuid) returns boolean
  language sql stable security definer set search_path = public
as $$
  select exists (select 1 from membership where user_id = p_user_id and org_id = p_org_id)
$$;
revoke all on function is_member(uuid, uuid) from public;
grant execute on function is_member(uuid, uuid) to app_user;

-- The signed-in user's own org (auth.uid()); safe to expose to authenticated
-- because it can only ever resolve the caller's own membership. Used by
-- current_org() step 3 without recursing into membership RLS.
create or replace function current_user_org() returns uuid
  language sql stable security definer set search_path = public
as $$
  select org_id from membership where user_id = auth.uid() order by created_at limit 1
$$;
revoke all on function current_user_org() from public;
grant execute on function current_user_org() to authenticated, app_user;

-- Onboard a member. SECURITY DEFINER; server-only (NOT granted to authenticated,
-- or a signed-in user could add themselves to any org).
create or replace function add_member(p_user_id uuid, p_org_id uuid, p_role text default 'staff')
  returns void language sql security definer set search_path = public
as $$
  insert into membership (user_id, org_id, role) values (p_user_id, p_org_id, p_role)
  on conflict (user_id, org_id) do update set role = excluded.role
$$;
revoke all on function add_member(uuid, uuid, text) from public;
grant execute on function add_member(uuid, uuid, text) to app_user;

-- ---------------------------------------------------------------------------
-- The dual-source resolver. GUC > JWT claim > membership.
create or replace function current_org() returns uuid
  language plpgsql stable set search_path = public, pg_catalog
as $$
declare
  v_txt text;
  v_org uuid;
  v_uid uuid;
begin
  -- 1. explicit GUC (tests, server-derived context) — always wins
  v_txt := nullif(current_setting('app.current_org', true), '');
  if v_txt is not null then
    return v_txt::uuid;
  end if;

  -- 2. org_id claim on a Supabase Auth JWT
  begin
    v_txt := nullif(current_setting('request.jwt.claims', true), '');
    if v_txt is not null then
      v_org := (v_txt::jsonb ->> 'org_id')::uuid;
      if v_org is not null then
        return v_org;
      end if;
    end if;
  exception when others then
    -- malformed claims: ignore and fall through
    null;
  end;

  -- 3. the signed-in user's membership
  begin
    v_uid := auth.uid();
    if v_uid is not null then
      return current_user_org();
    end if;
  exception when others then
    null;
  end;

  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Mirror app_user's table/view privileges onto `authenticated`, so the same RLS
-- policies (org_id = current_org()) serve PostgREST/client access on Supabase.
-- INSERT/UPDATE/DELETE match app_user exactly (e.g. authenticated cannot
-- UPDATE/DELETE the ledger or bids, just like app_user).
do $$
declare r record;
begin
  for r in
    select table_name, privilege_type
    from information_schema.role_table_grants
    where grantee = 'app_user' and table_schema = 'public'
  loop
    execute format('grant %s on public.%I to authenticated', r.privilege_type, r.table_name);
  end loop;
end $$;

grant usage on schema public to authenticated;
grant execute on all functions in schema public to authenticated;
-- ...but never the privileged/platform functions.
revoke execute on function create_org(text) from authenticated;
revoke execute on function resolve_user_org(uuid) from authenticated;
revoke execute on function add_member(uuid, uuid, text) from authenticated;
