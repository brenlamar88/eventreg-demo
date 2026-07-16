import { test, expect, afterAll } from 'vitest';
import { createOrg, orgClient, closeAll } from './helpers/db.ts';
import { makeParty, makeEvent, makeLot, makeFlatRate, postAward } from './helpers/seed.ts';

afterAll(closeAll);

// Awarding a lot makes the winner a buyer and the consignor a consignor at the
// event — so the multi-role model is queryable, not just implied by the ledger.
test('post_lot_award assigns buyer and consignor roles idempotently', async () => {
  const orgId = await createOrg('award-roles-org');
  const c = await orgClient(orgId);
  try {
    const eventId = await makeEvent(c, orgId, 'Gala');
    const buyer = await makeParty(c, orgId, 'person', 'Buyer');
    const consignor = await makeParty(c, orgId, 'org', 'Estate');
    await makeFlatRate(c, orgId, eventId, 'buyers_premium', 1000, null);
    await makeFlatRate(c, orgId, eventId, 'sellers_commission', 500, null);
    const lot = await makeLot(c, orgId, eventId, consignor);

    // award twice — roles must appear exactly once each (idempotent)
    await postAward(c, lot, buyer, 100_000n);
    await postAward(c, lot, buyer, 100_000n);

    const roles = await c.query(
      'select party_id, role from role_at_event where event_id = $1 order by role',
      [eventId],
    );
    expect(roles.rows).toEqual([
      { party_id: buyer, role: 'buyer' },
      { party_id: consignor, role: 'consignor' },
    ]);
  } finally {
    await c.end();
  }
});
