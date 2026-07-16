import { test, expect, afterAll } from 'vitest';
import fc from 'fast-check';
import { createOrg, orgClient, closeAll } from './helpers/db.ts';
import { makeAuction, postAward } from './helpers/seed.ts';

afterAll(closeAll);

// Money rule 2: corrections are reversing entries, and they always net correctly.
// Property: after reversing every entry of an award (any number of times, since
// reversal is idempotent), all three settlement figures are exactly zero, each
// original has exactly one reversal, and no original row was mutated.
test('reversing an award nets to zero, is idempotent, and never mutates originals', async () => {
  const orgId = await createOrg('reversal-org');
  const c = await orgClient(orgId);
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 0n, max: 1_000_000_000n }),
        fc.integer({ min: 1, max: 5 }), // reversal replay count
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        async (hammer, reverseReplays, premiumBps, commissionBps) => {
          const ctx = await makeAuction(c, orgId, premiumBps, commissionBps);
          await postAward(c, ctx.lotId, ctx.buyerId, hammer);

          const originals = await c.query(
            "select id, amount_cents from ledger_entry where idempotency_key like $1 and reverses_id is null",
            [`award:${ctx.lotId}%`],
          );
          expect(originals.rows).toHaveLength(4);

          for (const e of originals.rows) {
            for (let i = 0; i < reverseReplays; i++) {
              await c.query('select reverse_entry($1, now())', [e.id]);
            }
          }

          // exactly one reversal per original despite the replays
          const revCounts = await c.query(
            `select reverses_id, count(*)::int n from ledger_entry
             where reverses_id = any($1::uuid[]) group by reverses_id`,
            [originals.rows.map((r) => r.id)],
          );
          expect(revCounts.rows).toHaveLength(4);
          for (const r of revCounts.rows) expect(r.n).toBe(1);

          // settlement nets to zero
          const inv = await c.query(
            'select coalesce(invoice_cents,0) v from v_buyer_invoice where event_id=$1 and party_id=$2',
            [ctx.eventId, ctx.buyerId],
          );
          const pay = await c.query(
            'select coalesce(payout_cents,0) v from v_consignor_payout where event_id=$1 and party_id=$2',
            [ctx.eventId, ctx.consignorId],
          );
          const rev = await c.query(
            'select realized_fee_cents v from v_operator_revenue where event_id=$1',
            [ctx.eventId],
          );
          expect(BigInt(inv.rows[0].v)).toBe(0n);
          expect(BigInt(pay.rows[0].v)).toBe(0n);
          expect(BigInt(rev.rows[0].v)).toBe(0n);

          // originals byte-for-byte unchanged
          const after = await c.query(
            'select id, amount_cents from ledger_entry where id = any($1::uuid[]) order by id',
            [originals.rows.map((r) => r.id)],
          );
          const before = [...originals.rows].sort((a, b) => (a.id < b.id ? -1 : 1));
          for (let i = 0; i < before.length; i++) {
            expect(BigInt(after.rows[i].amount_cents)).toBe(BigInt(before[i].amount_cents));
          }
        },
      ),
      { numRuns: 40 },
    );
  } finally {
    await c.end();
  }
});
