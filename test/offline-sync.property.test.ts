import { test, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import type pg from 'pg';
import { admin, createOrg, orgClient, closeAll } from './helpers/db.ts';
import { createHubDatabase, hubAdmin, hubOrgClient, mirrorFixture } from './helpers/hub.ts';
import { replayOutbox, twoWaySync, type Query } from '../src/hub/sync.ts';

// Phase 5: the venue hub is a REAL second Postgres database. These tests
// enqueue ops on both sides and replay the monotonic-sequence queue between
// them — no mocks.

beforeAll(async () => {
  await createHubDatabase();
});
afterAll(closeAll);

const q = (c: pg.Client): Query => (text, params) => c.query(text, params as any[]);

// Mirror one org to both sides and hand back tenant clients for each.
async function mirroredOrg(name: string) {
  const orgId = await createOrg(name);
  const ha = await hubAdmin();
  await ha.query('insert into org(id, name) values ($1,$2)', [orgId, name]);
  await ha.end();
  const cloud = await orgClient(orgId);
  const hub = await hubOrgClient(orgId);
  const fixture = await mirrorFixture(cloud, hub, orgId);
  return { orgId, cloud, hub, fixture };
}

function bidPayload(f: { eventId: string; lotId: string }, bidder: string, amount: bigint) {
  return JSON.stringify({
    event_id: f.eventId,
    lot_id: f.lotId,
    bidder_party_id: bidder,
    amount_cents: amount.toString(),
    placed_at: '2026-07-16T19:00:00Z',
  });
}

// THE bid guarantee: arbitrary bid streams from multiple devices, replayed with
// duplicate deliveries in both directions, end as exactly the union on BOTH
// sides. No bid lost. No bid merged. None applied twice.
test('bids from many devices sync to exactly the union — never lost, merged, or doubled', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.bigInt({ min: 0n, max: 100_000_000n }), { maxLength: 5 }), // iPad 1 (hub)
      fc.array(fc.bigInt({ min: 0n, max: 100_000_000n }), { maxLength: 5 }), // iPad 2 (hub)
      fc.array(fc.bigInt({ min: 0n, max: 100_000_000n }), { maxLength: 4 }), // web (cloud)
      fc.integer({ min: 1, max: 3 }), // duplicate replay count
      async (ipad1, ipad2, web, replays) => {
        const { cloud, hub, fixture } = await mirroredOrg(`sync-${crypto.randomUUID().slice(0, 8)}`);
        try {
          // originate ops: iPads write to the hub, web bidders to the cloud
          const enqueue = (c: pg.Client, device: string, seq: number, amount: bigint, bidder: string) =>
            c.query('select enqueue_op($1,$2,$3,$4)', [
              device,
              seq,
              'bid',
              bidPayload(fixture, bidder, amount),
            ]);
          for (let i = 0; i < ipad1.length; i++) await enqueue(hub, 'ipad-1', i + 1, ipad1[i], fixture.bidder1);
          for (let i = 0; i < ipad2.length; i++) await enqueue(hub, 'ipad-2', i + 1, ipad2[i], fixture.bidder2);
          for (let i = 0; i < web.length; i++) await enqueue(cloud, 'web-1', i + 1, web[i], fixture.bidder1);

          // replay with duplicates, both directions
          for (let i = 0; i < replays; i++) await replayOutbox(q(hub), q(cloud));
          await twoWaySync(q(cloud), q(hub));

          // a full second pass must be pure duplicates
          const second = await twoWaySync(q(cloud), q(hub));
          expect(second.aToB.applied).toBe(0);
          expect(second.bToA.applied).toBe(0);

          // both sides hold exactly the union, byte-identical per (device, seq)
          const total = ipad1.length + ipad2.length + web.length;
          for (const side of [cloud, hub]) {
            const { rows } = await side.query(
              `select device_id, device_seq::text, amount_cents::text
                 from bid where lot_id = $1
                order by device_id, device_seq`,
              [fixture.lotId],
            );
            expect(rows.length).toBe(total);
            const check = (device: string, amounts: bigint[]) => {
              const mine = rows.filter((r) => r.device_id === device);
              expect(mine.map((r) => r.device_seq)).toEqual(amounts.map((_, i) => String(i + 1)));
              expect(mine.map((r) => BigInt(r.amount_cents))).toEqual(amounts);
            };
            check('ipad-1', ipad1);
            check('ipad-2', ipad2);
            check('web-1', web);
          }
        } finally {
          await cloud.end();
          await hub.end();
        }
      },
    ),
    { numRuns: 15 },
  );
}, 120_000);

// A sequence gap must refuse loudly — a silently skipped op is a lost bid.
test('a sequence gap is refused, then heals when the missing op arrives', async () => {
  const { cloud, hub, fixture } = await mirroredOrg('gap-org');
  try {
    const payload = (n: bigint) => bidPayload(fixture, fixture.bidder1, n);
    await hub.query("select apply_sync_op('ipad-9', 1, 'bid', $1)", [payload(100n)]);
    // seq 3 with 2 missing -> refuse
    await expect(
      hub.query("select apply_sync_op('ipad-9', 3, 'bid', $1)", [payload(300n)]),
    ).rejects.toThrow(/sequence gap/i);
    // the missing op arrives -> stream heals in order
    const r2 = await hub.query("select apply_sync_op('ipad-9', 2, 'bid', $1) as r", [payload(200n)]);
    const r3 = await hub.query("select apply_sync_op('ipad-9', 3, 'bid', $1) as r", [payload(300n)]);
    expect(r2.rows[0].r).toBe('applied');
    expect(r3.rows[0].r).toBe('applied');
    const { rows } = await hub.query(
      "select count(*)::int n from bid where device_id = 'ipad-9'",
    );
    expect(rows[0].n).toBe(3);
  } finally {
    await cloud.end();
    await hub.end();
  }
});

// Bids get ledger discipline: append-only for the tenant role AND the superuser.
test('bid table rejects UPDATE/DELETE like the ledger', async () => {
  const { cloud, hub, fixture } = await mirroredOrg('bid-appendonly-org');
  try {
    await cloud.query("select enqueue_op('web-2', 1, 'bid', $1)", [
      bidPayload(fixture, fixture.bidder1, 5000n),
    ]);
    await expect(
      cloud.query('update bid set amount_cents = 1 where device_id = $1', ['web-2']),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      cloud.query('delete from bid where device_id = $1', ['web-2']),
    ).rejects.toMatchObject({ code: '42501' });
    // superuser bypasses grants and RLS but not the trigger
    await expect(
      admin.query('update bid set amount_cents = 1 where device_id = $1', ['web-2']),
    ).rejects.toThrow(/append-only/);
    await expect(
      admin.query('delete from bid where device_id = $1', ['web-2']),
    ).rejects.toThrow(/append-only/);
  } finally {
    await cloud.end();
    await hub.end();
  }
});

// Registrations: last-write-wins with a deterministic (updated_at, device_id)
// tiebreak — hub and cloud converge to the identical winner in EITHER apply order.
test('conflicting registrations converge to the same winner in either order', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 3_600_000 }), // op A offset ms
      fc.integer({ min: 0, max: 3_600_000 }), // op B offset ms (may be equal)
      fc.constantFrom('registered', 'checked_in', 'cancelled'),
      fc.constantFrom('registered', 'checked_in', 'cancelled'),
      async (offA, offB, statusA, statusB) => {
        const { cloud, hub, fixture } = await mirroredOrg(`lww-${crypto.randomUUID().slice(0, 8)}`);
        try {
          const base = Date.UTC(2026, 6, 16, 18, 0, 0);
          const tA = new Date(base + offA).toISOString();
          const tB = new Date(base + offB).toISOString();
          const reg = (t: string, status: string) =>
            JSON.stringify({
              event_id: fixture.eventId,
              party_id: fixture.bidder1,
              status,
              updated_at: t,
            });

          // op A originates on the hub (ipad-1), op B on the cloud (web-1)
          await hub.query("select enqueue_op('ipad-1', 1, 'registration', $1)", [reg(tA, statusA)]);
          await cloud.query("select enqueue_op('web-1', 1, 'registration', $1)", [reg(tB, statusB)]);

          // hub applies cloud-first order; cloud applies hub-first order
          await replayOutbox(q(cloud), q(hub));
          await replayOutbox(q(hub), q(cloud));

          const expectWinner =
            offA > offB || (offA === offB && 'ipad-1' > 'web-1') ? statusA : statusB;

          for (const side of [cloud, hub]) {
            const { rows } = await side.query(
              'select status, source_device_id from registration where event_id=$1 and party_id=$2',
              [fixture.eventId, fixture.bidder1],
            );
            expect(rows).toHaveLength(1);
            expect(rows[0].status).toBe(expectWinner);
          }
          // and both sides agree exactly
          const a = await cloud.query(
            'select status, updated_at, source_device_id from registration where event_id=$1 and party_id=$2',
            [fixture.eventId, fixture.bidder1],
          );
          const b = await hub.query(
            'select status, updated_at, source_device_id from registration where event_id=$1 and party_id=$2',
            [fixture.eventId, fixture.bidder1],
          );
          expect(a.rows[0]).toEqual(b.rows[0]);
        } finally {
          await cloud.end();
          await hub.end();
        }
      },
    ),
    { numRuns: 20 },
  );
}, 120_000);
