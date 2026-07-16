// Apply all SQL migrations in order. Reused by the test global-setup and the
// `npm run db:migrate` CLI.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export async function applyMigrations(client: pg.Client): Promise<void> {
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await client.query(sql);
    } catch (err) {
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }
}

// CLI: node --experimental-strip-types scripts/migrate.ts [connectionString]
if (import.meta.url === `file://${process.argv[1]}`) {
  const url =
    process.argv[2] ??
    process.env.DATABASE_URL_ADMIN ??
    'postgres://postgres@127.0.0.1:55432/eventreg_test';
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await applyMigrations(client);
  await client.end();
  console.log('migrations applied');
}
