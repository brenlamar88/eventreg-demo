// Replay the sync queue between two databases (venue hub <-> cloud).
//
// Sync is NOT a diff: it ships sync_outbox rows the target hasn't seen, in
// per-device sequence order, through apply_sync_op — which is where the fixed
// conflict policy lives (bids append-only, registrations LWW) and where
// duplicates no-op and gaps refuse loudly. Running replay any number of times
// is equivalent to running it once.
//
// Both sides are plain query functions so tests can wire two real Postgres
// databases; the tenant context (app.current_org) must already be set on each.

export type Query = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export interface ReplayResult {
  applied: number;
  duplicates: number;
}

// One direction: source's outbox -> target.
export async function replayOutbox(source: Query, target: Query): Promise<ReplayResult> {
  // Target's per-device high-water marks; ops at or below are already applied.
  const { rows: cursorRows } = await target(
    'select device_id, last_seq::text from sync_device_cursor',
  );
  const cursors = new Map<string, bigint>(
    cursorRows.map((r) => [r.device_id as string, BigInt(r.last_seq)]),
  );

  // Full outbox in (device, seq) order. Filtering by cursor is an optimization;
  // apply_sync_op remains the correctness authority for duplicates/gaps.
  const { rows: ops } = await source(
    `select device_id, device_seq::text, op_type, payload
       from sync_outbox
      order by device_id, device_seq`,
  );

  let applied = 0;
  let duplicates = 0;
  for (const op of ops) {
    const seq = BigInt(op.device_seq);
    const seen = cursors.get(op.device_id) ?? -1n;
    if (seq <= seen) {
      duplicates++;
      continue;
    }
    const { rows } = await target('select apply_sync_op($1,$2,$3,$4) as r', [
      op.device_id,
      op.device_seq,
      op.op_type,
      op.payload,
    ]);
    if (rows[0].r === 'applied') applied++;
    else duplicates++;
  }
  return { applied, duplicates };
}

// Hub <-> cloud: replay each side's outbox at the other. Ops carry their
// originating device and are never re-outboxed on apply, so there are no loops.
export async function twoWaySync(a: Query, b: Query): Promise<{ aToB: ReplayResult; bToA: ReplayResult }> {
  const aToB = await replayOutbox(a, b);
  const bToA = await replayOutbox(b, a);
  return { aToB, bToA };
}
