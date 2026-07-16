// Demo data seeding, expressed against a generic query function so it can run
// from the server action (via withOrg) OR the CLI (via a raw app_user client).
// Deliberately NOT importing db.ts/'server-only', so the CLI can use it too.
//
// Assumes the tenant context (app.current_org) is already set for `q`.

export type Query = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

async function id(q: Query, text: string, params: unknown[]): Promise<string> {
  const { rows } = await q(text, params);
  return rows[0].id as string;
}

export async function seedDemo(q: Query, orgId: string): Promise<{ eventId: string }> {
  // operator connects their own Stripe account
  await q(
    "insert into stripe_account(org_id, stripe_account_id) values ($1,'acct_demo') on conflict do nothing",
    [orgId],
  );

  const eventId = await id(
    q,
    "insert into event(org_id, name, starts_at) values ($1,$2, now() + interval '30 days') returning id",
    [orgId, 'Spring Gala 2026'],
  );

  // parties
  const jim = await id(
    q,
    "insert into party(org_id, kind, display_name, email) values ($1,'person','Jim Boudreaux','jim@example.com') returning id",
    [orgId],
  );
  const marie = await id(
    q,
    "insert into party(org_id, kind, display_name, email) values ($1,'person','Marie Thibodeaux','marie@example.com') returning id",
    [orgId],
  );
  const acme = await id(
    q,
    "insert into party(org_id, kind, display_name) values ($1,'org','Acme Corp') returning id",
    [orgId],
  );
  const estate = await id(
    q,
    "insert into party(org_id, kind, display_name) values ($1,'org','Estate of R. Landry') returning id",
    [orgId],
  );
  const anonDonor = await id(
    q,
    "insert into party(org_id, kind, display_name) values ($1,'person','Claire Fontenot') returning id",
    [orgId],
  );

  // rates: 15% buyer's premium, 10% seller's commission
  const premSched = await id(
    q,
    "insert into rate_schedule(org_id, event_id, kind, effective_at) values ($1,$2,'buyers_premium', now() - interval '1 day') returning id",
    [orgId, eventId],
  );
  await q('insert into rate_tier(org_id, rate_schedule_id, lower_bound_cents, rate_bps) values ($1,$2,0,1500)', [orgId, premSched]);
  const commSched = await id(
    q,
    "insert into rate_schedule(org_id, event_id, kind, effective_at) values ($1,$2,'sellers_commission', now() - interval '1 day') returning id",
    [orgId, eventId],
  );
  await q('insert into rate_tier(org_id, rate_schedule_id, lower_bound_cents, rate_bps) values ($1,$2,0,1000)', [orgId, commSched]);

  // lots (consigned by the Estate) with fair market values
  const lot1 = await id(
    q,
    "insert into lot(org_id, event_id, consignor_party_id, label, fmv_cents) values ($1,$2,$3,'Weekend in Tuscany',150000) returning id",
    [orgId, eventId, estate],
  );
  const lot2 = await id(
    q,
    "insert into lot(org_id, event_id, consignor_party_id, label, fmv_cents) values ($1,$2,$3,'Signed Saints Jersey',40000) returning id",
    [orgId, eventId, estate],
  );

  // awards: Jim wins lot1 at $2,000; Marie wins lot2 at $600
  await q('select post_lot_award($1,$2,$3, now())', [lot1, jim, 200000]);
  await q('select post_lot_award($1,$2,$3, now())', [lot2, marie, 60000]);

  // sponsorships (with benefit FMV)
  await q('select record_sponsorship($1,$2,$3,$4,$5, now())', [eventId, jim, 500000, 60000, 'demo-spon-jim']);
  await q('select record_sponsorship($1,$2,$3,$4,$5, now())', [eventId, acme, 1000000, 120000, 'demo-spon-acme']);

  // donations (fund-a-need)
  await q('select record_donation($1,$2,$3,$4,$5, now())', [eventId, jim, 100000, 'Fund-a-Need', 'demo-don-jim']);
  await q('select record_donation($1,$2,$3,$4,$5, now())', [eventId, anonDonor, 50000, 'General', 'demo-don-claire']);

  // Jim pays his auction invoice: hammer 2000 + 15% premium 300 = 2300; app fee =
  // his premium 300 + the commission on his lot 200 = 500
  await q('select record_payment($1,$2,$3,$4,$5,$6,$7, now())', [
    jim,
    eventId,
    230000,
    50000,
    'pi_demo_jim',
    'acct_demo',
    'stripe:evt_demo_jim',
  ]);

  return { eventId };
}
