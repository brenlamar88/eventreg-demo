import { test, expect, afterAll } from 'vitest';
import { createOrg, orgClient, closeAll } from './helpers/db.ts';
import { makeParty, makeEvent, makeLot, makeFlatRate, postAward } from './helpers/seed.ts';
import { setLotFmv, recordSponsorship, recordDonation } from './helpers/fundraising.ts';

afterAll(closeAll);

// The differentiator, stated plainly: ONE identity is a sponsor, a buyer, AND a
// donor at the same event, and produces a SINGLE consolidated tax receipt.
// No competitor whose sponsor/buyer/donor records are separate roots can do this.
test('one party across sponsor + buyer + donor roles gets a single consolidated receipt', async () => {
  const orgId = await createOrg('consolidation-org');
  const c = await orgClient(orgId);
  try {
    const eventId = await makeEvent(c, orgId, 'Spring Gala');
    const jim = await makeParty(c, orgId, 'person', 'Jim Boudreaux');
    const estate = await makeParty(c, orgId, 'org', 'Consignor Estate');
    await makeFlatRate(c, orgId, eventId, 'buyers_premium', 1000, null); // 10%
    await makeFlatRate(c, orgId, eventId, 'sellers_commission', 0, null);

    // Jim sponsors $5,000 with a table worth $600 FMV
    await recordSponsorship(c, eventId, jim, 5_000_00n, 600_00n, 'spon-jim');
    // Jim donates $1,000 (fund-a-need, fully deductible)
    await recordDonation(c, eventId, jim, 1_000_00n, 'don-jim');
    // Jim buys a lot: hammer $2,000, item FMV $1,500; premium 10% = $200
    const lot = await makeLot(c, orgId, eventId, estate);
    await setLotFmv(c, lot, 1_500_00n);
    await postAward(c, lot, jim, 2_000_00n);

    // exactly one receipt row for Jim
    const receipt = await c.query(
      `select gross_cents, fmv_cents, deductible_cents, line_count, requires_quid_pro_quo_disclosure
       from v_donor_tax_receipt where event_id=$1 and party_id=$2`,
      [eventId, jim],
    );
    expect(receipt.rows).toHaveLength(1);

    // gross = 5000 + 1000 + (2000 + 200) = 8200.00
    expect(BigInt(receipt.rows[0].gross_cents)).toBe(820_000n);
    // fmv = 600 + 0 + 1500 = 2100.00
    expect(BigInt(receipt.rows[0].fmv_cents)).toBe(210_000n);
    // deductible = (5000-600) + 1000 + (2200-1500) = 4400 + 1000 + 700 = 6100.00
    expect(BigInt(receipt.rows[0].deductible_cents)).toBe(610_000n);
    expect(receipt.rows[0].line_count).toBe(3);
    expect(receipt.rows[0].requires_quid_pro_quo_disclosure).toBe(true);

    // three distinct source lines
    const lines = await c.query(
      `select source_type, gross_cents, fmv_cents, deductible_cents
       from v_tax_receipt_line where event_id=$1 and party_id=$2 order by source_type`,
      [eventId, jim],
    );
    expect(lines.rows.map((r) => r.source_type)).toEqual(['auction', 'donation', 'sponsorship']);
  } finally {
    await c.end();
  }
});
