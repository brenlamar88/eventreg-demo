// Auth is optional in local dev: when the Supabase env vars are absent the app
// runs in "open" mode (the org picker) so the demo needs zero setup. When they
// are present, real Supabase Auth + membership-scoped tenancy kick in.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

export function supabaseConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
}
