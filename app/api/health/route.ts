import { NextResponse } from 'next/server';
import { dbHealth } from '../../lib/db';
import { supabaseConfigured, authEnabled } from '../../lib/supabase/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// One-glance deploy status: GET /api/health
//   200 => DB reachable and all migrations applied
//   503 => DB unreachable, or migrations missing (see `db`, `dbError`, `migrations`)
export async function GET() {
  const db = await dbHealth();
  const migrationsApplied =
    db.connected && Object.values(db.checks).length > 0 && Object.values(db.checks).every(Boolean);
  const ok = db.connected && migrationsApplied;

  return NextResponse.json(
    {
      status: ok ? 'ok' : 'error',
      db: db.connected ? 'connected' : 'unreachable',
      ...(db.error ? { dbError: db.error } : {}),
      migrations: db.checks,
      migrationsApplied,
      auth: authEnabled() ? 'enabled' : supabaseConfigured() ? 'keys-set-open-mode' : 'open-mode',
      time: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
