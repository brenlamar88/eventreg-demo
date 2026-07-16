import { test, expect, afterAll } from 'vitest';
import { admin, createOrg, orgClient, closeAll } from './helpers/db.ts';
import { makeAuction, postAward } from './helpers/seed.ts';

afterAll(closeAll);

// Money rule 2: the ledger is append-only. Two independent guards:
//   1. the tenant role (app_user) has no UPDATE/DELETE privilege at all;
//   2. a trigger rejects UPDATE/DELETE even for a superuser (who bypasses RLS
//      and privileges but NOT triggers).
test('ledger rejects UPDATE/DELETE for both the tenant role and a superuser', async () => {
  const orgId = await createOrg('append-only-org');
  const c = await orgClient(orgId);
  let entryId: string;
  try {
    const ctx = await makeAuction(c, orgId, 1000, 500);
    await postAward(c, ctx.lotId, ctx.buyerId, 100_000n);
    const { rows } = await c.query(
      "select id from ledger_entry where idempotency_key like $1 limit 1",
      [`award:${ctx.lotId}%`],
    );
    entryId = rows[0].id;

    // 1. tenant role: no privilege (42501)
    await expect(
      c.query('update ledger_entry set amount_cents = 1 where id = $1', [entryId]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      c.query('delete from ledger_entry where id = $1', [entryId]),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await c.end();
  }

  // 2. superuser: privilege + RLS bypassed, but the trigger still fires
  await expect(
    admin.query('update ledger_entry set amount_cents = 1 where id = $1', [entryId]),
  ).rejects.toThrow(/append-only/);
  await expect(
    admin.query('delete from ledger_entry where id = $1', [entryId]),
  ).rejects.toThrow(/append-only/);
});
