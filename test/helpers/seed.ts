import type pg from 'pg';

// All inserts pass org_id explicitly = the client's tenant context, exercising
// the RLS WITH CHECK path (a mismatched org_id would be rejected).

export async function makeParty(
  c: pg.Client,
  orgId: string,
  kind: 'person' | 'org',
  name: string,
): Promise<string> {
  const { rows } = await c.query(
    'insert into party(org_id, kind, display_name) values ($1,$2,$3) returning id',
    [orgId, kind, name],
  );
  return rows[0].id;
}

export async function makeEvent(c: pg.Client, orgId: string, name: string): Promise<string> {
  const { rows } = await c.query(
    'insert into event(org_id, name) values ($1,$2) returning id',
    [orgId, name],
  );
  return rows[0].id;
}

export async function addRole(
  c: pg.Client,
  orgId: string,
  eventId: string,
  partyId: string,
  role: string,
): Promise<string> {
  const { rows } = await c.query(
    'insert into role_at_event(org_id, event_id, party_id, role) values ($1,$2,$3,$4) returning id',
    [orgId, eventId, partyId, role],
  );
  return rows[0].id;
}

export async function makeLot(
  c: pg.Client,
  orgId: string,
  eventId: string,
  consignorId: string,
): Promise<string> {
  const { rows } = await c.query(
    'insert into lot(org_id, event_id, consignor_party_id) values ($1,$2,$3) returning id',
    [orgId, eventId, consignorId],
  );
  return rows[0].id;
}

// Create a single-tier (flat) rate schedule effective in the past.
export async function makeFlatRate(
  c: pg.Client,
  orgId: string,
  eventId: string,
  kind: 'buyers_premium' | 'sellers_commission',
  bps: number,
  consignorId: string | null = null,
): Promise<string> {
  const { rows } = await c.query(
    `insert into rate_schedule(org_id, event_id, kind, consignor_party_id, effective_at)
     values ($1,$2,$3,$4, now() - interval '1 day') returning id`,
    [orgId, eventId, kind, consignorId],
  );
  const scheduleId = rows[0].id;
  await c.query(
    'insert into rate_tier(org_id, rate_schedule_id, lower_bound_cents, rate_bps) values ($1,$2,0,$3)',
    [orgId, scheduleId, bps],
  );
  return scheduleId;
}

export interface AuctionCtx {
  eventId: string;
  consignorId: string;
  buyerId: string;
  lotId: string;
}

// A minimal but complete auction context in one org: an event with a consignor,
// a buyer, a lot, and flat premium/commission rates.
export async function makeAuction(
  c: pg.Client,
  orgId: string,
  premiumBps: number,
  commissionBps: number,
): Promise<AuctionCtx> {
  const eventId = await makeEvent(c, orgId, 'Gala Auction');
  const consignorId = await makeParty(c, orgId, 'org', 'Consignor Estate');
  const buyerId = await makeParty(c, orgId, 'person', 'Buyer Jim');
  await addRole(c, orgId, eventId, consignorId, 'consignor');
  await addRole(c, orgId, eventId, buyerId, 'buyer');
  const lotId = await makeLot(c, orgId, eventId, consignorId);
  await makeFlatRate(c, orgId, eventId, 'buyers_premium', premiumBps, null);
  await makeFlatRate(c, orgId, eventId, 'sellers_commission', commissionBps, null);
  return { eventId, consignorId, buyerId, lotId };
}

export async function postAward(
  c: pg.Client,
  lotId: string,
  buyerId: string,
  hammerCents: bigint,
): Promise<void> {
  await c.query('select post_lot_award($1,$2,$3, now())', [lotId, buyerId, hammerCents.toString()]);
}
