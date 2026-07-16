// Vitest global setup: build a fresh test database and apply all migrations once.
import pg from 'pg';
import { applyMigrations } from '../scripts/migrate.ts';

const HOST = process.env.PGHOST ?? '127.0.0.1';
const PORT = process.env.PGPORT ?? '55432';
const MAINT_URL =
  process.env.DATABASE_URL_MAINT ?? `postgres://postgres@${HOST}:${PORT}/postgres`;
const TEST_DB = process.env.TEST_DB ?? 'eventreg_test';
const TEST_URL =
  process.env.DATABASE_URL_ADMIN ?? `postgres://postgres@${HOST}:${PORT}/${TEST_DB}`;

export default async function setup() {
  const maint = new pg.Client({ connectionString: MAINT_URL });
  await maint.connect();
  await maint.query(
    `select pg_terminate_backend(pid) from pg_stat_activity
       where datname = $1 and pid <> pg_backend_pid()`,
    [TEST_DB],
  );
  await maint.query(`drop database if exists ${TEST_DB}`);
  await maint.query(`create database ${TEST_DB}`);
  await maint.end();

  const db = new pg.Client({ connectionString: TEST_URL });
  await db.connect();
  await applyMigrations(db);
  await db.end();
}
