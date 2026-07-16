import { redirect } from 'next/navigation';
import { authEnabled } from './lib/supabase/env';
import { missingDbEnv } from './lib/db';
import { getUser, currentUserOrg } from './lib/auth';
import { SetupRequired } from './components/setup-required';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function Home() {
  // Unconfigured deploy: render the setup checklist, never a 500.
  const missing = missingDbEnv();
  if (missing.length > 0) return <SetupRequired missing={missing} />;
  // open demo mode (default): straight to the platform org picker
  if (!authEnabled()) redirect('/orgs');

  // auth mode: send the signed-in operator to their own org
  const user = await getUser();
  if (!user) redirect('/login');
  const org = await currentUserOrg(user);
  if (!org) redirect('/login?error=' + encodeURIComponent('No organization membership for this account'));
  redirect(`/orgs/${org}`);
}
