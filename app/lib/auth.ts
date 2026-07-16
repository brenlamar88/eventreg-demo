import 'server-only';
import { redirect } from 'next/navigation';
import { authEnabled } from './supabase/env';
import { createSupabaseServerClient } from './supabase/server';
import { withOrg } from './db';

export interface SessionUser {
  id: string;
  email: string | null;
}

// The verified signed-in user, or null (including whenever auth is not
// configured — "open" demo mode).
export async function getUser(): Promise<SessionUser | null> {
  if (!authEnabled()) return null;
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return { id: user.id, email: user.email ?? null };
}

// The org the signed-in user belongs to, derived SERVER-SIDE from the verified
// session via the SECURITY DEFINER resolver — never from client input. Returns
// null in open mode. We borrow any org's context only to call the definer
// function (which ignores it); the lookup itself is not tenant-scoped.
export async function currentUserOrg(user: SessionUser): Promise<string | null> {
  // resolve_user_org bypasses RLS (SECURITY DEFINER), so the GUC value is
  // irrelevant; use a throwaway zero-uuid context just to open the session.
  return withOrg('00000000-0000-0000-0000-000000000000', async (q) => {
    const { rows } = await q('select resolve_user_org($1) as org', [user.id]);
    return (rows[0]?.org as string | null) ?? null;
  });
}

// Guard an org-scoped page. In open mode this is a no-op (demo). With auth on,
// it requires a signed-in user who is a member of `orgId`, so a logged-in
// operator cannot reach another org by editing the URL.
export async function assertMember(orgId: string): Promise<void> {
  if (!authEnabled()) return; // open demo mode
  const user = await getUser();
  if (!user) redirect('/login');
  const isMember = await withOrg('00000000-0000-0000-0000-000000000000', async (q) => {
    const { rows } = await q('select is_member($1,$2) as ok', [user.id, orgId]);
    return rows[0]?.ok === true;
  });
  if (!isMember) redirect('/');
}
