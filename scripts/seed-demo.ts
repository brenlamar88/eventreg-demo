// Seed a fully-populated demo operator into the app database.
// Usage: node --experimental-strip-types scripts/seed-demo.ts
import pg from 'pg';
import { seedDemo } from '../app/lib/seed.ts';

const HOST = process.env.PGHOST ?? '127.0.0.1';
const PORT = process.env.PGPORT ?? '55432';
const DB = process.env.APP_DB ?? 'eventreg_test';
const ADMIN = process.env.DATABASE_URL_ADMIN ?? `postgres://postgres@${HOST}:${PORT}/${DB}`;
const APP = process.env.DATABASE_URL_APP ?? `postgres://app_user@${HOST}:${PORT}/${DB}`;

const admin = new pg.Client({ connectionString: ADMIN });
await admin.connect();
const { rows } = await admin.query('select create_org($1) as id', ['Bayou Charitable Auctions']);
const orgId = rows[0].id as string;
await admin.end();

const app = new pg.Client({ connectionString: APP });
await app.connect();
await app.query("select set_config('app.current_org', $1, false)", [orgId]);
const { eventId } = await seedDemo((text, params) => app.query(text, params as any[]), orgId);
await app.end();

console.log('Seeded demo operator.');
console.log(`  org:   ${orgId}`);
console.log(`  event: ${eventId}`);
console.log(`  visit: /orgs/${orgId}/events/${eventId}`);
