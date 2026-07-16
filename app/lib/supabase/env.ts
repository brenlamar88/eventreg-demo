// Auth is optional in local dev AND on a fresh deploy: the app only *requires*
// login when auth is explicitly turned on. This matters because the one-click
// Supabase↔Vercel integration sets NEXT_PUBLIC_SUPABASE_* automatically — we do
// NOT want that alone to force login before any users/memberships exist. So:
//   - supabaseConfigured(): the Supabase keys are present (client can be built)
//   - authEnabled(): keys present AND NEXT_PUBLIC_AUTH_ENABLED=true (require login)
// With keys but no flag, the app stays in open mode (org picker, no login).
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

export function supabaseConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
}

export function authEnabled(): boolean {
  return supabaseConfigured() && process.env.NEXT_PUBLIC_AUTH_ENABLED === 'true';
}
