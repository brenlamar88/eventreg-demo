import { test, expect, afterAll } from 'vitest';
import fc from 'fast-check';
import { createOrg, orgClient, roundHalfUpBps, closeAll } from './helpers/db.ts';
import { makeParty, makeEvent, addRole, makeLot, makeFlatRate, postAward } from './helpers/seed.ts';
import { setLotFmv, recordSponsorship, recordDonation } from './helpers/fundraising.ts';

afterAll(closeAll);

let seq = 0;
const key = (p: string) => `${p}_${++seq}_${crypto.randomUUID().slice(0, 8)}`;

// deductible = Σ per-line max(0, gross − fmv), across an arbitrary mix of a
// sponsorship, a donation, and an auction win — all for ONE party, consolidated.
test('consolidated tax receipt totals equal per-line deductible over all roles', async () => {
  const orgId = await createOrg('receipt-org');
  const c = await orgClient(orgId);
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 0n, max: 2_000_000n }), // sponsorship amount
        fc.bigInt({ min: 0n, max: 2_000_000n }), // sponsorship benefit FMV
        fc.bigInt({ min: 0n, max: 2_000_000n }), // donation amount
        fc.bigInt({ min: 0n, max: 2_000_000n }), // hammer
        fc.integer({ min: 0, max: 3000 }), // premium bps
        fc.bigInt({ min: 0n, max: 2_000_000n }), // lot FMV
        async (sponAmt, sponFmv, donAmt, hammer, premiumBps, lotFmv) => {
          const eventId = await makeEvent(c, orgId, 'Gala');
          const party = await makeParty(c, orgId, 'org', 'Boudreaux Foundation');
          const consignor = await makeParty(c, orgId, 'org', 'Estate');
          await makeFlatRate(c, orgId, eventId, 'buyers_premium', premiumBps, null);
          await makeFlatRate(c, orgId, eventId, 'sellers_commission', 0, null);

          // sponsorship + donation
          await recordSponsorship(c, eventId, party, sponAmt, sponFmv, key('sp'));
          await recordDonation(c, eventId, party, donAmt, key('dn'));

          // auction win by the same party
          const lot = await makeLot(c, orgId, eventId, consignor);
          await setLotFmv(c, lot, lotFmv);
          await postAward(c, lot, party, hammer);

          const premium = roundHalfUpBps(hammer, premiumBps);
          const auctionPaid = hammer + premium;

          const expectDeductible =
            (sponAmt > sponFmv ? sponAmt - sponFmv : 0n) +
            donAmt +
            (auctionPaid > lotFmv ? auctionPaid - lotFmv : 0n);
          const expectGross = sponAmt + donAmt + auctionPaid;
          const expectFmv = sponFmv + 0n + lotFmv;

          const r = await c.query(
            `select gross_cents, fmv_cents, deductible_cents, line_count
             from v_donor_tax_receipt where event_id=$1 and party_id=$2`,
            [eventId, party],
          );
          expect(r.rows).toHaveLength(1);
          expect(BigInt(r.rows[0].gross_cents)).toBe(expectGross);
          expect(BigInt(r.rows[0].fmv_cents)).toBe(expectFmv);
          expect(BigInt(r.rows[0].deductible_cents)).toBe(expectDeductible);
          expect(r.rows[0].line_count).toBe(3);
        },
      ),
      { numRuns: 40 },
    );
  } finally {
    await c.end();
  }
});

// Fundraising income must NOT inflate the platform billing base (fees only).
test('donations and sponsorships never change the platform billing base', async () => {
  const orgId = await createOrg('billing-invariance-org');
  const c = await orgClient(orgId);
  try {
    const eventId = await makeEvent(c, orgId, 'Gala');
    const consignor = await makeParty(c, orgId, 'org', 'Estate');
    const buyer = await makeParty(c, orgId, 'person', 'Buyer');
    await makeFlatRate(c, orgId, eventId, 'buyers_premium', 1000, null); // 10%
    await makeFlatRate(c, orgId, eventId, 'sellers_commission', 500, null); // 5%
    const lot = await makeLot(c, orgId, eventId, consignor);
    await postAward(c, lot, buyer, 100_000n);

    const before = await c.query(
      'select realized_fee_cents from v_platform_billing where event_id=$1',
      [eventId],
    );
    const feeBefore = BigInt(before.rows[0].realized_fee_cents);

    // pile on fundraising income
    const donor = await makeParty(c, orgId, 'person', 'Donor');
    await recordDonation(c, eventId, donor, 5_000_00n, key('dn'));
    await recordSponsorship(c, eventId, donor, 10_000_00n, 600_00n, key('sp'));

    const after = await c.query(
      'select realized_fee_cents from v_platform_billing where event_id=$1',
      [eventId],
    );
    // realized fee = 10% + 5% of 100_000 = 15_000, unchanged by fundraising
    expect(BigInt(after.rows[0].realized_fee_cents)).toBe(feeBefore);
    expect(feeBefore).toBe(15_000n);
  } finally {
    await c.end();
  }
});
