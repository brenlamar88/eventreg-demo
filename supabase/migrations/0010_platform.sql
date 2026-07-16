-- 0010_platform.sql
-- Platform-level onboarding. Creating an operator is a ROW, never a fork or a
-- code change. SECURITY DEFINER so it runs above tenant RLS to seed the org;
-- this is the SAME path that creates org #1 and org #500.

create or replace function create_org(p_name text) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into org (id, name) values (v_id, p_name);
  return v_id;
end $$;

grant execute on function create_org(text) to app_user;
