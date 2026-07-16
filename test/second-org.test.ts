import { test, expect, afterAll } from 'vitest';
import { admin, createOrg, orgClient, roundHalfUpBps, closeAll } from './helpers/db.ts';
import { makeAuction, postAward } from './helpers/seed.ts';

afterAll(closeAll);

// Phase 1 definition of done, bullet 1:
// "A second org is created via SQL: fully functional, fully isolated, empty."
test('a second org created via SQL is empty, isolated, and fully functional', async () => {
  // org #1 with real activity
  const org1 = await createOrg('Operator One');
  const c1 = await orgClient(org1);
  const ctx1 = await makeAuction(c1, org1, 1000, 500);
  await postAward(c1, ctx1.lotId, ctx1.buyerId, 500_000n);

  // org #2 via the exact same SQL path (no code change, no fork)
  const org2 = await createOrg('Operator Two');
  const c2 = await orgClient(org2);

  try {
    // EMPTY: every tenant table other than `org` shows zero rows for org2
    const tenantTables = [
      'party',
      'party_representation',
      'event',
      'role_at_event',
      'lot',
      'rate_schedule',
      'rate_tier',
      'ledger_entry',
    ];
    for (const t of tenantTables) {
      const { rows } = await c2.query(`select count(*)::int n from ${t}`);
      expect(rows[0].n, `${t} should be empty for a fresh org`).toBe(0);
    }
    // org2 sees exactly one org row: itself
    const orgVisible = await c2.query('select id from org');
    expect(orgVisible.rows).toHaveLength(1);
    expect(orgVisible.rows[0].id).toBe(org2);

    // FUNCTIONAL: run a complete auction in org2
    const ctx2 = await makeAuction(c2, org2, 1500, 800);
    await postAward(c2, ctx2.lotId, ctx2.buyerId, 200_000n);
    const inv2 = await c2.query(
      'select invoice_cents from v_buyer_invoice where event_id=$1 and party_id=$2',
      [ctx2.eventId, ctx2.buyerId],
    );
    expect(BigInt(inv2.rows[0].invoice_cents)).toBe(200_000n + roundHalfUpBps(200_000n, 1500));

    // ISOLATED: org2 cannot see org1's event/ledger; org1 is unchanged
    const leak = await c2.query('select count(*)::int n from ledger_entry where event_id=$1', [
      ctx1.eventId,
    ]);
    expect(leak.rows[0].n).toBe(0);

    const inv1 = await c1.query(
      'select invoice_cents from v_buyer_invoice where event_id=$1 and party_id=$2',
      [ctx1.eventId, ctx1.buyerId],
    );
    expect(BigInt(inv1.rows[0].invoice_cents)).toBe(500_000n + roundHalfUpBps(500_000n, 1000));

    // and org1's ledger row count is untouched by anything org2 did
    const org1Rows = await admin.query(
      'select count(*)::int n from ledger_entry where org_id=$1',
      [org1],
    );
    expect(org1Rows.rows[0].n).toBe(4);
  } finally {
    await c1.end();
    await c2.end();
  }
});
