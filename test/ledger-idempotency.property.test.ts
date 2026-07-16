import { test, expect, afterAll } from 'vitest';
import fc from 'fast-check';
import { createOrg, orgClient, roundHalfUpBps, closeAll } from './helpers/db.ts';
import { makeAuction, postAward } from './helpers/seed.ts';

afterAll(closeAll);

// Money rule 3: a duplicate write is physically incapable of double-writing.
// Property: posting the same award any number of times leaves exactly the
// single-post result — 4 rows, and identical settlement figures.
test('replaying an award N times equals posting it once', async () => {
  const orgId = await createOrg('idem-org');
  const c = await orgClient(orgId);
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 0n, max: 1_000_000_000n }),
        fc.integer({ min: 1, max: 8 }), // replay count (e.g. duplicate webhooks)
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        async (hammer, replays, premiumBps, commissionBps) => {
          const ctx = await makeAuction(c, orgId, premiumBps, commissionBps);
          for (let i = 0; i < replays; i++) {
            await postAward(c, ctx.lotId, ctx.buyerId, hammer);
          }
          const cnt = await c.query(
            "select count(*)::int n from ledger_entry where idempotency_key like $1",
            [`award:${ctx.lotId}%`],
          );
          expect(cnt.rows[0].n).toBe(4); // exactly 4, regardless of replays

          const inv = await c.query(
            'select invoice_cents from v_buyer_invoice where event_id=$1 and party_id=$2',
            [ctx.eventId, ctx.buyerId],
          );
          expect(BigInt(inv.rows[0].invoice_cents)).toBe(hammer + roundHalfUpBps(hammer, premiumBps));
        },
      ),
      { numRuns: 40 },
    );
  } finally {
    await c.end();
  }
});

// The guarantee is at the DB level, not just in the posting function: a raw
// second insert with a duplicate (org_id, idempotency_key) is rejected.
test('duplicate idempotency_key is physically rejected by the DB constraint', async () => {
  const orgId = await createOrg('idem-constraint-org');
  const c = await orgClient(orgId);
  try {
    const ctx = await makeAuction(c, orgId, 100, 100);
    const insert = (amount: number) =>
      c.query(
        `insert into ledger_entry(org_id,event_id,party_id,role,entry_type,amount_cents,idempotency_key)
         values ($1,$2,$3,'buyer','payment',$4,'stripe:evt_dup_1')`,
        [orgId, ctx.eventId, ctx.buyerId, amount],
      );
    await insert(500);
    // second webhook delivery, same event id, even a different amount:
    await expect(insert(999)).rejects.toMatchObject({ code: '23505' });

    // and only the first write survives
    const { rows } = await c.query(
      "select amount_cents from ledger_entry where idempotency_key='stripe:evt_dup_1'",
    );
    expect(rows).toHaveLength(1);
    expect(BigInt(rows[0].amount_cents)).toBe(500n);
  } finally {
    await c.end();
  }
});
