import { test, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { admin, createOrg, orgClient, closeAll } from './helpers/db.ts';
import { makeParty, makeEvent } from './helpers/seed.ts';

afterAll(closeAll);

// Phase 6: the Supabase path, exercised locally against the REAL `authenticated`
// role. We SET LOCAL ROLE authenticated and set request.jwt.claims exactly as
// Supabase's PostgREST does, so RLS resolves the tenant from the JWT / membership
// with no GUC in play.

let orgA: string;
let orgB: string;
let userInA: string;

beforeAll(async () => {
  orgA = await createOrg('JWT Tenant A');
  orgB = await createOrg('JWT Tenant B');

  const ca = await orgClient(orgA);
  const cb = await orgClient(orgB);
  try {
    await makeEvent(ca, orgA, 'A Gala');
    await makeParty(ca, orgA, 'person', 'Alice in A');
    await makeEvent(cb, orgB, 'B Gala');
    await makeParty(cb, orgB, 'person', 'Bob in B');
  } finally {
    await ca.end();
    await cb.end();
  }

  // a Supabase user who belongs to org A
  userInA = crypto.randomUUID();
  await admin.query('insert into auth.users(id) values ($1)', [userInA]);
  await admin.query('select add_member($1,$2,$3)', [userInA, orgA, 'admin']);
});

// Run fn as the `authenticated` role with the given JWT claims and (optionally)
// an explicit app.current_org GUC — all LOCAL to a rolled-back transaction.
async function asAuthenticated<T>(
  claims: Record<string, unknown>,
  fn: (c: pg.PoolClient) => Promise<T>,
  guc?: string,
): Promise<T> {
  const c = await admin.connect();
  try {
    await c.query('begin');
    await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    if (guc) await c.query("select set_config('app.current_org', $1, true)", [guc]);
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}

test('JWT org_id claim scopes RLS to that org (read + write)', async () => {
  await asAuthenticated({ org_id: orgA, sub: userInA, role: 'authenticated' }, async (c) => {
    const own = await c.query('select count(*)::int n from party where org_id = $1', [orgA]);
    const foreign = await c.query('select count(*)::int n from party where org_id <> $1', [orgA]);
    expect(own.rows[0].n).toBeGreaterThan(0);
    expect(foreign.rows[0].n).toBe(0); // cannot see org B at all

    // can write into own org
    await c.query("insert into party(org_id, kind, display_name) values ($1,'person','new A')", [orgA]);
    // cannot write into org B (RLS WITH CHECK)
    await expect(
      c.query("insert into party(org_id, kind, display_name) values ($1,'person','smuggled')", [orgB]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

test('with no GUC and no org claim, membership resolves the org via auth.uid()', async () => {
  await asAuthenticated({ sub: userInA, role: 'authenticated' }, async (c) => {
    // current_org() falls through to the signed-in user's membership (org A)
    const resolved = await c.query('select current_org() as org');
    expect(resolved.rows[0].org).toBe(orgA);

    const own = await c.query('select count(*)::int n from party where org_id = $1', [orgA]);
    const foreign = await c.query('select count(*)::int n from party where org_id <> $1', [orgA]);
    expect(own.rows[0].n).toBeGreaterThan(0);
    expect(foreign.rows[0].n).toBe(0);
  });
});

test('the app.current_org GUC still wins over a JWT claim', async () => {
  // JWT says B, GUC says A -> A wins (keeps every prior test valid)
  await asAuthenticated(
    { org_id: orgB, sub: userInA },
    async (c) => {
      const resolved = await c.query('select current_org() as org');
      expect(resolved.rows[0].org).toBe(orgA);
    },
    orgA,
  );
});

test('a user sees only their own membership row', async () => {
  const otherUser = crypto.randomUUID();
  await admin.query('insert into auth.users(id) values ($1)', [otherUser]);
  await admin.query('select add_member($1,$2,$3)', [otherUser, orgB, 'staff']);

  await asAuthenticated({ sub: userInA }, async (c) => {
    const rows = await c.query('select org_id from membership');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].org_id).toBe(orgA); // not the other user's membership in B
  });
});

test('resolve_user_org gives the server a verified user’s org', async () => {
  const { rows } = await admin.query('select resolve_user_org($1) as org', [userInA]);
  expect(rows[0].org).toBe(orgA);
});
