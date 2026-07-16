import { test, expect, afterAll } from 'vitest';
import fc from 'fast-check';
import { createOrg, orgClient, closeAll } from './helpers/db.ts';
import { makeAuction, postAward } from './helpers/seed.ts';

afterAll(closeAll);

// lot_award is a denormalization used by receipts. It must NEVER drift from the
// ledger (the money source of truth): its stored amounts equal the corresponding
// ledger award entries, for arbitrary hammer and rates.
test('lot_award amounts always equal the ledger award entries', async () => {
  const orgId = await createOrg('lot-award-org');
  const c = await orgClient(orgId);
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 0n, max: 5_000_000n }),
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        async (hammer, premiumBps, commissionBps) => {
          const ctx = await makeAuction(c, orgId, premiumBps, commissionBps);
          await postAward(c, ctx.lotId, ctx.buyerId, hammer);

          const la = await c.query(
            'select buyer_party_id, hammer_cents, buyers_premium_cents, sellers_commission_cents from lot_award where lot_id=$1',
            [ctx.lotId],
          );
          expect(la.rows).toHaveLength(1);
          const row = la.rows[0];

          const led = await c.query(
            `select entry_type, role, amount_cents from ledger_entry
             where idempotency_key like $1`,
            [`award:${ctx.lotId}%`],
          );
          const byKey = (t: string, role: string) =>
            BigInt(led.rows.find((r) => r.entry_type === t && r.role === role)!.amount_cents);

          expect(row.buyer_party_id).toBe(ctx.buyerId);
          expect(BigInt(row.hammer_cents)).toBe(byKey('hammer', 'buyer'));
          expect(BigInt(row.buyers_premium_cents)).toBe(byKey('buyers_premium', 'buyer'));
          // commission stored positive in lot_award, negative in the ledger
          expect(BigInt(row.sellers_commission_cents)).toBe(-byKey('sellers_commission', 'consignor'));
        },
      ),
      { numRuns: 40 },
    );
  } finally {
    await c.end();
  }
});
