-- 0002_tenancy.sql
-- The tenant. Every other table carries org_id and is isolated by RLS on it.

create table org (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

-- The tenant context for the current DB session. Set per-transaction via
--   select set_config('app.current_org', '<uuid>', false);
-- Returns NULL when unset so RLS predicates simply match no rows (deny closed)
-- rather than erroring.
create or replace function current_org() returns uuid
  language sql stable
  -- pin search_path so the custom GUC name can't be shadowed
  set search_path = pg_catalog
as $$
  select nullif(current_setting('app.current_org', true), '')::uuid
$$;

grant execute on function current_org() to app_user;
