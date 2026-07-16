import { redirect } from 'next/navigation';
import { supabaseConfigured } from './lib/supabase/env';
import { getUser, currentUserOrg } from './lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function Home() {
  // open demo mode: straight to the platform org picker
  if (!supabaseConfigured()) redirect('/orgs');

  // auth mode: send the signed-in operator to their own org
  const user = await getUser();
  if (!user) redirect('/login');
  const org = await currentUserOrg(user);
  if (!org) redirect('/login?error=' + encodeURIComponent('No organization membership for this account'));
  redirect(`/orgs/${org}`);
}
