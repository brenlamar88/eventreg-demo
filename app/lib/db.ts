import 'server-only';
import pg from 'pg';

// The app connects as the non-superuser `app_user`, so Row-Level Security is
// enforced on every query — the same isolation the Phase 1 tests prove. Each
// request runs inside a transaction that sets app.current_org via SET LOCAL, so
// the tenant context can never leak between pooled connections.

const APP_URL = process.env.DATABASE_URL_APP ?? process.env.POSTGRES_URL; // Vercel/Supabase convention
const ADMIN_URL = process.env.DATABASE_URL_ADMIN ?? process.env.POSTGRES_URL_NON_POOLING;

const LOCAL_APP = 'postgres://app_user@127.0.0.1:55432/eventreg_test';
const LOCAL_ADMIN = 'postgres://postgres@127.0.0.1:55432/eventreg_test';
const isProd = process.env.NODE_ENV === 'production';

function connString(url: string | undefined, localFallback: string, envName: string): string {
  if (url && url.length > 0) return url;
  // In production, refuse to silently connect to a dev database — surface a
  // clear message instead of an opaque ECONNREFUSED to 127.0.0.1.
  if (isProd) {
    throw new Error(
      `${envName} is not set. Point it at your Supabase Postgres connection string ` +
        `(app role: app_user). See .env.example / docs/DEPLOY.md.`,
    );
  }
  return localFallback;
}

// node-postgres does NOT enable SSL by default, but Supabase (and most hosted
// Postgres) require it. Enable SSL for any non-local host.
function poolFor(url: string, max: number): pg.Pool {
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  return new pg.Pool({
    connectionString: url,
    max,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  });
}

declare global {
  // eslint-disable-next-line no-var
  var __v8_pool: pg.Pool | undefined;
  // eslint-disable-next-line no-var
  var __v8_admin_pool: pg.Pool | undefined;
}

// Reuse pools across hot reloads / lambda invocations. Lazily constructed so a
// missing env var only errors on first use (with the clear message above),
// never at module import.
function appPool(): pg.Pool {
  if (!global.__v8_pool) global.__v8_pool = poolFor(connString(APP_URL, LOCAL_APP, 'DATABASE_URL_APP'), 5);
  return global.__v8_pool;
}
function adminPool(): pg.Pool {
  if (!global.__v8_admin_pool)
    global.__v8_admin_pool = poolFor(connString(ADMIN_URL, LOCAL_ADMIN, 'DATABASE_URL_ADMIN'), 2);
  return global.__v8_admin_pool;
}

// Run a callback with the tenant context bound for the whole transaction.
export async function withOrg<T>(
  orgId: string,
  fn: (q: (text: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>,
): Promise<T> {
  const client = await appPool().connect();
  try {
    await client.query('begin');
    // set_config(..., true) => LOCAL to this transaction only.
    await client.query("select set_config('app.current_org', $1, true)", [orgId]);
    const result = await fn((text, params) => client.query(text, params as any[]));
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Platform-level pool for cross-tenant screens like the org picker (open mode).
export async function adminQuery(text: string, params?: unknown[]): Promise<pg.QueryResult> {
  return adminPool().query(text, params as any[]);
}

// Which required DB env vars are missing in production. Pages use this to render
// a "setup required" screen instead of crashing into the error boundary.
export function missingDbEnv(): string[] {
  if (!isProd) return [];
  const missing: string[] = [];
  if (!APP_URL) missing.push('DATABASE_URL_APP');
  if (!ADMIN_URL) missing.push('DATABASE_URL_ADMIN');
  return missing;
}

// Connectivity + schema probe for /api/health. Never throws — reports the reason
// instead, so a deploy can be diagnosed at a glance.
export async function dbHealth(): Promise<{
  connected: boolean;
  error?: string;
  checks: Record<string, boolean>;
}> {
  try {
    const client = await appPool().connect();
    try {
      const { rows } = await client.query(`
        select
          to_regclass('public.ledger_entry')      is not null as ledger,
          to_regclass('public.membership')        is not null as membership,
          to_regprocedure('public.current_org()') is not null as current_org,
          to_regclass('public.v_platform_billing') is not null as billing
      `);
      return { connected: true, checks: rows[0] as Record<string, boolean> };
    } finally {
      client.release();
    }
  } catch (err) {
    return { connected: false, error: (err as Error).message, checks: {} };
  }
}
