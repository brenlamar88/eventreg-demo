import { test, expect, afterAll } from 'vitest';
import fc from 'fast-check';
import { createOrg, orgClient, roundHalfUpBps, closeAll } from './helpers/db.ts';
import { makeAuction, postAward } from './helpers/seed.ts';

afterAll(closeAll);

// Money rule 5, property-tested (not three happy-path examples):
//   buyer invoice    = Σ hammer + (hammer × buyers_premium_rate)
//   consignor payout = Σ hammer − (hammer × sellers_commission_rate)
//   operator revenue = Σ buyers_premium + Σ sellers_commission
// with half-up rounding per lot, over arbitrary hammer and rate combinations.
test('settlement math holds for arbitrary hammer and rates', async () => {
  const orgId = await createOrg('settle-org');
  const c = await orgClient(orgId);
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 0n, max: 10_000_000_000n }), // hammer: $0 .. $100M
        fc.integer({ min: 0, max: 100_000 }), // premium bps: 0 .. 1000%
        fc.integer({ min: 0, max: 100_000 }), // commission bps
        async (hammer, premiumBps, commissionBps) => {
          const ctx = await makeAuction(c, orgId, premiumBps, commissionBps);
          await postAward(c, ctx.lotId, ctx.buyerId, hammer);

          const inv = await c.query(
            'select invoice_cents from v_buyer_invoice where event_id=$1 and party_id=$2',
            [ctx.eventId, ctx.buyerId],
          );
          const pay = await c.query(
            'select payout_cents from v_consignor_payout where event_id=$1 and party_id=$2',
            [ctx.eventId, ctx.consignorId],
          );
          const rev = await c.query(
            'select realized_fee_cents from v_operator_revenue where event_id=$1',
            [ctx.eventId],
          );

          const premium = roundHalfUpBps(hammer, premiumBps);
          const commission = roundHalfUpBps(hammer, commissionBps);

          expect(BigInt(inv.rows[0].invoice_cents)).toBe(hammer + premium);
          expect(BigInt(pay.rows[0].payout_cents)).toBe(hammer - commission);
          expect(BigInt(rev.rows[0].realized_fee_cents)).toBe(premium + commission);
        },
      ),
      { numRuns: 60 },
    );
  } finally {
    await c.end();
  }
});

// The realized-fee billing base equals the sum of every buyer invoice's premium
// plus every consignor's commission across an event — one live figure.
test('operator realized fee equals total premium + total commission across many lots', async () => {
  const orgId = await createOrg('billing-base-org');
  const c = await orgClient(orgId);
  try {
    const premiumBps = 1500; // 15%
    const commissionBps = 1000; // 10%
    const ctx = await makeAuction(c, orgId, premiumBps, commissionBps);
    // sell several more lots by the same consignor into the same event
    const hammers = [12_345n, 999n, 1n, 7_500_000n, 250_000n];
    let expected = 0n;
    // first lot from makeAuction
    await postAward(c, ctx.lotId, ctx.buyerId, hammers[0]);
    expected += roundHalfUpBps(hammers[0], premiumBps) + roundHalfUpBps(hammers[0], commissionBps);
    for (const h of hammers.slice(1)) {
      const { rows } = await c.query(
        'insert into lot(org_id,event_id,consignor_party_id) values ($1,$2,$3) returning id',
        [orgId, ctx.eventId, ctx.consignorId],
      );
      await postAward(c, rows[0].id, ctx.buyerId, h);
      expected += roundHalfUpBps(h, premiumBps) + roundHalfUpBps(h, commissionBps);
    }
    const rev = await c.query(
      'select realized_fee_cents from v_operator_revenue where event_id=$1',
      [ctx.eventId],
    );
    expect(BigInt(rev.rows[0].realized_fee_cents)).toBe(expected);
  } finally {
    await c.end();
  }
});
