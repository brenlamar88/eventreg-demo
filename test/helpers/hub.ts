import pg from 'pg';
import { applyMigrations } from '../../scripts/migrate.ts';

// A second, real database standing in for the venue hub (Postgres on the NUC).
// Same migrations, same schema — sync tests replay the op queue between the two.

const HOST = process.env.PGHOST ?? '127.0.0.1';
const PORT = process.env.PGPORT ?? '55432';
export const HUB_DB = 'eventreg_test_hub';
const MAINT_URL =
  process.env.DATABASE_URL_MAINT ?? `postgres://postgres@${HOST}:${PORT}/postgres`;
export const HUB_ADMIN_URL = `postgres://postgres@${HOST}:${PORT}/${HUB_DB}`;
export const HUB_APP_URL = `postgres://app_user@${HOST}:${PORT}/${HUB_DB}`;

export async function createHubDatabase(): Promise<void> {
  const maint = new pg.Client({ connectionString: MAINT_URL });
  await maint.connect();
  await maint.query(
    `select pg_terminate_backend(pid) from pg_stat_activity
      where datname = $1 and pid <> pg_backend_pid()`,
    [HUB_DB],
  );
  await maint.query(`drop database if exists ${HUB_DB}`);
  await maint.query(`create database ${HUB_DB}`);
  await maint.end();

  const db = new pg.Client({ connectionString: HUB_ADMIN_URL });
  await db.connect();
  await applyMigrations(db);
  await db.end();
}

export async function hubAdmin(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: HUB_ADMIN_URL });
  await c.connect();
  return c;
}

export async function hubOrgClient(orgId: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: HUB_APP_URL });
  await c.connect();
  await c.query("select set_config('app.current_org', $1, false)", [orgId]);
  return c;
}

export interface MirroredFixture {
  eventId: string;
  lotId: string;
  consignorId: string;
  bidder1: string;
  bidder2: string;
}

// Pre-event sync (assumption A5): the org and its catalog (event, parties, lots)
// exist identically on BOTH sides before bidding starts. Explicit UUIDs, same
// rows inserted on each side through the tenant client.
export async function mirrorFixture(
  cloud: pg.Client,
  hub: pg.Client,
  orgId: string,
): Promise<MirroredFixture> {
  const f: MirroredFixture = {
    eventId: crypto.randomUUID(),
    lotId: crypto.randomUUID(),
    consignorId: crypto.randomUUID(),
    bidder1: crypto.randomUUID(),
    bidder2: crypto.randomUUID(),
  };
  for (const c of [cloud, hub]) {
    await c.query('insert into event(id, org_id, name) values ($1,$2,$3)', [
      f.eventId,
      orgId,
      'Offline Gala',
    ]);
    await c.query(
      "insert into party(id, org_id, kind, display_name) values ($1,$2,'org','Estate'), ($3,$2,'person','Bidder One'), ($4,$2,'person','Bidder Two')",
      [f.consignorId, orgId, f.bidder1, f.bidder2],
    );
    await c.query(
      "insert into lot(id, org_id, event_id, consignor_party_id, label) values ($1,$2,$3,$4,'Lot A')",
      [f.lotId, orgId, f.eventId, f.consignorId],
    );
  }
  return f;
}
