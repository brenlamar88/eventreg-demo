import { signInAction } from '../lib/auth-actions';
import { supabaseConfigured } from '../lib/supabase/env';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  return (
    <div style={{ maxWidth: 380, margin: '8vh auto' }}>
      <h1>Sign in</h1>
      <p className="sub">Operator console</p>

      {!supabaseConfigured() ? (
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            Auth is not configured in this environment. The console is running in open
            demo mode.
          </p>
          <a href="/orgs">
            <button type="button">Continue to console →</button>
          </a>
        </div>
      ) : (
        <div className="card">
          {searchParams.error && (
            <p className="neg" style={{ marginTop: 0 }}>
              {searchParams.error}
            </p>
          )}
          <form action={signInAction} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label className="f">
              Email
              <input name="email" type="email" placeholder="you@association.org" required />
            </label>
            <label className="f">
              Password
              <input name="password" type="password" required />
            </label>
            <button type="submit">Sign in</button>
          </form>
        </div>
      )}
    </div>
  );
}
