import pg from 'pg';

const HOST = process.env.PGHOST ?? '127.0.0.1';
const PORT = process.env.PGPORT ?? '55432';

export const ADMIN_DB_URL =
  process.env.DATABASE_URL_ADMIN ?? `postgres://postgres@${HOST}:${PORT}/eventreg_test`;
export const APP_DB_URL =
  process.env.DATABASE_URL_APP ?? `postgres://app_user@${HOST}:${PORT}/eventreg_test`;

// Superuser pool: platform-level ops (create_org) and out-of-band assertions
// that need to see across tenants (verifying what a tenant is NOT allowed to see).
export const admin = new pg.Pool({ connectionString: ADMIN_DB_URL });

// A connected app_user client bound to exactly one org's tenant context.
// app_user is a non-superuser, non-owner role, so RLS is enforced against it.
export async function orgClient(orgId: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: APP_DB_URL });
  await c.connect();
  await c.query("select set_config('app.current_org', $1, false)", [orgId]);
  return c;
}

// Platform onboarding path — the same call that creates org #1 and org #500.
export async function createOrg(name: string): Promise<string> {
  const { rows } = await admin.query('select create_org($1) as id', [name]);
  return rows[0].id as string;
}

export function cents(v: string | number | bigint): bigint {
  return BigInt(v);
}

// Half-up rounding in integer cents, mirrored in TS so property tests compute the
// expected value independently of the DB. Matches round_half_up_bps() in SQL.
export function roundHalfUpBps(amountCents: bigint, bps: number): bigint {
  return (amountCents * BigInt(bps) + 5000n) / 10000n;
}

export async function closeAll(): Promise<void> {
  await admin.end();
}
