import 'server-only';
import pg from 'pg';

// The app connects as the non-superuser `app_user`, so Row-Level Security is
// enforced on every query — the same isolation the Phase 1 tests prove. Each
// request runs inside a transaction that sets app.current_org via SET LOCAL, so
// the tenant context can never leak between pooled connections.

const CONNECTION_STRING =
  process.env.DATABASE_URL_APP ??
  process.env.POSTGRES_URL ?? // Vercel/Supabase convention
  'postgres://app_user@127.0.0.1:55432/eventreg_test';

declare global {
  // eslint-disable-next-line no-var
  var __v8_pool: pg.Pool | undefined;
}

// Reuse one pool across hot reloads / lambda invocations.
const pool: pg.Pool = global.__v8_pool ?? new pg.Pool({ connectionString: CONNECTION_STRING, max: 5 });
if (process.env.NODE_ENV !== 'production') global.__v8_pool = pool;

// Run a callback with the tenant context bound for the whole transaction.
export async function withOrg<T>(
  orgId: string,
  fn: (q: (text: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // set_config(..., true) => LOCAL to this transaction only.
    await client.query("select set_config('app.current_org', $1, true)", [orgId]);
    const result = await fn((text, params) => client.query(text, params as any[]));
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

// Platform-level pool (superuser) for cross-tenant screens like the org picker.
// Kept separate and used only where showing all orgs is the explicit intent.
const ADMIN_CONNECTION_STRING =
  process.env.DATABASE_URL_ADMIN ??
  'postgres://postgres@127.0.0.1:55432/eventreg_test';
const adminPool: pg.Pool = new pg.Pool({ connectionString: ADMIN_CONNECTION_STRING, max: 2 });

export async function adminQuery(text: string, params?: unknown[]): Promise<pg.QueryResult> {
  return adminPool.query(text, params as any[]);
}
