import { test, expect, afterAll } from 'vitest';
import type pg from 'pg';
import { admin, createOrg, orgClient, closeAll } from './helpers/db.ts';
import { makeAuction, postAward } from './helpers/seed.ts';

afterAll(closeAll);

// Discover every base table and its tenant column. `org` isolates on `id`;
// everything else must carry `org_id`. A new table with neither fails the RLS
// test below — the acceptance criterion is self-extending.
async function tenantTables(): Promise<{ table: string; col: string }[]> {
  const { rows } = await admin.query(`
    select c.relname as table,
           exists (
             select 1 from pg_attribute a
             where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
           ) as has_org_id
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname
  `);
  return rows.map((r) => ({
    table: r.table,
    col: r.has_org_id ? 'org_id' : r.table === 'org' ? 'id' : '__none__',
  }));
}

// Seed every tenant table for one org, so the "sees its own rows" assertion is
// meaningful for all of them (a table nobody wrote can't prove isolation).
async function seedEverything(c: pg.Client, orgId: string): Promise<void> {
  const ctx = await makeAuction(c, orgId, 1000, 500); // event, party, role, lot, rate_schedule, rate_tier
  await postAward(c, ctx.lotId, ctx.buyerId, 100_000n); // ledger_entry
  await c.query(
    'insert into party_representation(org_id, agent_party_id, principal_party_id) values ($1,$2,$3)',
    [orgId, ctx.buyerId, ctx.consignorId],
  );
}

test('every base table has RLS enabled and forced', async () => {
  const { rows } = await admin.query(`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  `);
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.relrowsecurity, `${r.relname} must have RLS enabled`).toBe(true);
    expect(r.relforcerowsecurity, `${r.relname} must FORCE RLS`).toBe(true);
  }
});

test('zero cross-org data leakage on every table', async () => {
  const orgA = await createOrg('Tenant A');
  const orgB = await createOrg('Tenant B');
  const ca = await orgClient(orgA);
  const cb = await orgClient(orgB);
  try {
    await seedEverything(ca, orgA);
    await seedEverything(cb, orgB);

    const tables = await tenantTables();
    // guard: no orphan table slipped in without a tenant column
    for (const { table, col } of tables) {
      expect(col, `${table} has no tenant column`).not.toBe('__none__');
    }

    for (const { table, col } of tables) {
      // A sees none of B's rows...
      const aSeesForeign = await ca.query(
        `select count(*)::int n from ${table} where ${col} <> $1`,
        [orgA],
      );
      expect(aSeesForeign.rows[0].n, `${table}: A can see non-A rows`).toBe(0);
      // ...and does see its own (proving the table was populated and visible)
      const aSeesOwn = await ca.query(
        `select count(*)::int n from ${table} where ${col} = $1`,
        [orgA],
      );
      expect(aSeesOwn.rows[0].n, `${table}: A cannot see its own rows`).toBeGreaterThan(0);
      // symmetric for B
      const bSeesForeign = await cb.query(
        `select count(*)::int n from ${table} where ${col} <> $1`,
        [orgB],
      );
      expect(bSeesForeign.rows[0].n, `${table}: B can see non-B rows`).toBe(0);
    }

    // A cannot fetch a specific known B row by primary key
    const { rows: bParty } = await admin.query(
      'select id from party where org_id = $1 limit 1',
      [orgB],
    );
    const crossRead = await ca.query('select count(*)::int n from party where id = $1', [
      bParty[0].id,
    ]);
    expect(crossRead.rows[0].n).toBe(0);

    // A cannot write a row tagged as B (RLS WITH CHECK) => 42501
    await expect(
      ca.query('insert into party(org_id, kind, display_name) values ($1,$2,$3)', [
        orgB,
        'person',
        'smuggled',
      ]),
    ).rejects.toMatchObject({ code: '42501' });

    // A cannot update/delete B's rows: RLS makes them invisible, so 0 rows affected
    const upd = await ca.query('update party set display_name = $1 where id = $2', [
      'hacked',
      bParty[0].id,
    ]);
    expect(upd.rowCount).toBe(0);
    const del = await ca.query('delete from party where id = $1', [bParty[0].id]);
    expect(del.rowCount).toBe(0);
    // confirm B's row is untouched
    const stillThere = await admin.query('select count(*)::int n from party where id = $1', [
      bParty[0].id,
    ]);
    expect(stillThere.rows[0].n).toBe(1);
  } finally {
    await ca.end();
    await cb.end();
  }
});
