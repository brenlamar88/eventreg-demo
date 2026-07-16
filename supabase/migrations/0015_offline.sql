-- 0015_offline.sql
-- Offline venue hub machinery: the replayable monotonic-sequence op queue, the
-- FIXED conflict policy (bids append-only; registrations last-write-wins), and
-- the per-device cursor that makes replay idempotent and gaps loud.
--
-- The same schema runs on the venue hub (NUC) and in the cloud; sync in either
-- direction is "replay the other side's outbox" (src/hub/sync.ts).

-- Generic append-only guard (reusable; ledger has its own with the same shape).
create or replace function reject_mutation() returns trigger
  language plpgsql
as $$
begin
  raise exception '% is append-only; % is forbidden', tg_table_name, tg_op
    using errcode = 'raise_exception';
end $$;

-- ---------------------------------------------------------------------------
-- Registrations: last-write-wins on (org, event, party).
-- Winner = greatest (updated_at, source_device_id); the device-id tiebreak makes
-- convergence order-independent when timestamps collide.
create table registration (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references org(id),
  event_id         uuid not null references event(id),
  party_id         uuid not null references party(id),
  status           text not null default 'registered',
  updated_at       timestamptz not null,
  source_device_id text not null,
  unique (org_id, event_id, party_id)
);
create index registration_org_idx on registration(org_id);

alter table registration enable row level security;
alter table registration force row level security;
create policy registration_isolation on registration
  using (org_id = current_org()) with check (org_id = current_org());
grant select, insert, update on registration to app_user;  -- LWW upserts; no delete

-- ---------------------------------------------------------------------------
-- Bids: APPEND-ONLY. Never merge. Never drop. A bid is an intent, not money —
-- it reaches the ledger only via post_lot_award — but it gets ledger discipline:
-- integer cents, no UPDATE/DELETE (trigger + grants), and a natural idempotency
-- key (org_id, device_id, device_seq).
create table bid (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references org(id),
  event_id         uuid not null references event(id),
  lot_id           uuid not null references lot(id),
  bidder_party_id  uuid not null references party(id),
  amount_cents     bigint not null check (amount_cents >= 0),
  device_id        text not null,
  device_seq       bigint not null,
  placed_at        timestamptz not null,
  unique (org_id, device_id, device_seq)
);
create index bid_org_idx on bid(org_id);
create index bid_lot_idx on bid(org_id, lot_id, amount_cents desc);

create trigger bid_no_update before update on bid
  for each row execute function reject_mutation();
create trigger bid_no_delete before delete on bid
  for each row execute function reject_mutation();

alter table bid enable row level security;
alter table bid force row level security;
create policy bid_isolation on bid
  using (org_id = current_org()) with check (org_id = current_org());
grant select, insert on bid to app_user;   -- deliberately NO update/delete

-- ---------------------------------------------------------------------------
-- The op queue. Every offline-capable mutation is an op recorded here in the
-- SAME transaction that applies it locally, so the queue can never disagree
-- with local state. Append-only; UNIQUE per (org, device, seq).
create table sync_outbox (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references org(id),
  device_id   text not null,
  device_seq  bigint not null,
  op_type     text not null,
  payload     jsonb not null,
  recorded_at timestamptz not null default now(),
  unique (org_id, device_id, device_seq)
);
create index sync_outbox_org_idx on sync_outbox(org_id);

create trigger sync_outbox_no_update before update on sync_outbox
  for each row execute function reject_mutation();
create trigger sync_outbox_no_delete before delete on sync_outbox
  for each row execute function reject_mutation();

alter table sync_outbox enable row level security;
alter table sync_outbox force row level security;
create policy sync_outbox_isolation on sync_outbox
  using (org_id = current_org()) with check (org_id = current_org());
grant select, insert on sync_outbox to app_user;

-- Per-device high-water mark on the APPLYING side. Guarantees:
--   seq <= last_seq      -> duplicate (no-op; replay is idempotent)
--   seq  = last_seq + 1  -> apply and advance
--   seq  > last_seq + 1  -> GAP: refuse loudly. Silence is how bids get lost.
create table sync_device_cursor (
  org_id     uuid not null references org(id),
  device_id  text not null,
  last_seq   bigint not null default 0,
  primary key (org_id, device_id)
);

alter table sync_device_cursor enable row level security;
alter table sync_device_cursor force row level security;
create policy sync_device_cursor_isolation on sync_device_cursor
  using (org_id = current_org()) with check (org_id = current_org());
grant select, insert, update on sync_device_cursor to app_user;

-- ---------------------------------------------------------------------------
-- Apply one op. SECURITY INVOKER: runs under the caller's RLS.
-- Returns 'applied' or 'duplicate'; raises on gaps and unknown op types.
create or replace function apply_sync_op(
  p_device_id text,
  p_device_seq bigint,
  p_op_type text,
  p_payload jsonb
) returns text
  language plpgsql
as $$
declare
  v_org  uuid := current_org();
  v_last bigint;
begin
  if v_org is null then
    raise exception 'no tenant context (app.current_org unset)';
  end if;

  insert into sync_device_cursor (org_id, device_id, last_seq)
  values (v_org, p_device_id, 0)
  on conflict (org_id, device_id) do nothing;

  select last_seq into v_last
  from sync_device_cursor
  where org_id = v_org and device_id = p_device_id
  for update;                         -- serialize appliers per device

  if p_device_seq <= v_last then
    return 'duplicate';
  end if;
  if p_device_seq > v_last + 1 then
    raise exception 'sequence gap for device %: got seq %, cursor at % (missing % .. %)',
      p_device_id, p_device_seq, v_last, v_last + 1, p_device_seq - 1
      using errcode = 'raise_exception';
  end if;

  if p_op_type = 'bid' then
    insert into bid
      (org_id, event_id, lot_id, bidder_party_id, amount_cents, device_id, device_seq, placed_at)
    values
      (v_org,
       (p_payload->>'event_id')::uuid,
       (p_payload->>'lot_id')::uuid,
       (p_payload->>'bidder_party_id')::uuid,
       (p_payload->>'amount_cents')::bigint,
       p_device_id, p_device_seq,
       (p_payload->>'placed_at')::timestamptz)
    on conflict (org_id, device_id, device_seq) do nothing;

    insert into role_at_event (org_id, event_id, party_id, role)
    values (v_org, (p_payload->>'event_id')::uuid, (p_payload->>'bidder_party_id')::uuid, 'bidder')
    on conflict (org_id, event_id, party_id, role) do nothing;

  elsif p_op_type = 'registration' then
    insert into registration (org_id, event_id, party_id, status, updated_at, source_device_id)
    values
      (v_org,
       (p_payload->>'event_id')::uuid,
       (p_payload->>'party_id')::uuid,
       p_payload->>'status',
       (p_payload->>'updated_at')::timestamptz,
       p_device_id)
    on conflict (org_id, event_id, party_id) do update
      set status = excluded.status,
          updated_at = excluded.updated_at,
          source_device_id = excluded.source_device_id
      where (excluded.updated_at, excluded.source_device_id)
          > (registration.updated_at, registration.source_device_id);

    insert into role_at_event (org_id, event_id, party_id, role)
    values (v_org, (p_payload->>'event_id')::uuid, (p_payload->>'party_id')::uuid, 'registrant')
    on conflict (org_id, event_id, party_id, role) do nothing;

  else
    raise exception 'unknown op_type: %', p_op_type;
  end if;

  update sync_device_cursor
  set last_seq = p_device_seq
  where org_id = v_org and device_id = p_device_id;

  return 'applied';
end $$;
grant execute on function apply_sync_op(text, bigint, text, jsonb) to app_user;

-- Originate an op locally: record it in the outbox AND apply it, atomically.
-- If apply raises (gap, bad payload), the outbox row rolls back with it — the
-- queue never contains an op the origin itself didn't accept.
create or replace function enqueue_op(
  p_device_id text,
  p_device_seq bigint,
  p_op_type text,
  p_payload jsonb
) returns text
  language plpgsql
as $$
declare
  v_org uuid := current_org();
begin
  if v_org is null then
    raise exception 'no tenant context (app.current_org unset)';
  end if;

  insert into sync_outbox (org_id, device_id, device_seq, op_type, payload)
  values (v_org, p_device_id, p_device_seq, p_op_type, p_payload)
  on conflict (org_id, device_id, device_seq) do nothing;

  return apply_sync_op(p_device_id, p_device_seq, p_op_type, p_payload);
end $$;
grant execute on function enqueue_op(text, bigint, text, jsonb) to app_user;
