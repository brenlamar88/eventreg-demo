# V8 Event Platform

A single platform for associations that run large consignment auctions as
fundraisers — the one product that spans **fundraising** (sponsorships, donor
receipting) and **consignor settlement**, because its data model can express one
party holding several roles (sponsor, bidder, buyer, consignor) at the same
event.

Design rationale and the full architectural argument live in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Read it first — the party model
and the append-only ledger are the whole bet.

## Phase 1 (this repo)

Party model + append-only ledger + multi-tenancy. `org_id` through the schema,
Row-Level Security at the row level, and money that is integer-cents,
idempotency-keyed, and append-only.

- Schema & policies: [`supabase/migrations/`](supabase/migrations)
- Acceptance tests (the contract): [`test/`](test)

### Acceptance criteria, as executable tests

| Requirement | Test |
|---|---|
| A second org created via SQL is empty, isolated, fully functional | `test/second-org.test.ts` |
| Zero cross-org data leakage on **every** table (self-extending) | `test/tenancy-isolation.test.ts` |
| Ledger cannot double-write on a duplicate idempotency key | `test/ledger-idempotency.property.test.ts` |
| Reversing entries always net to zero and never mutate originals | `test/ledger-reversal.property.test.ts` |
| Settlement math (buyer invoice / consignor payout / operator revenue) | `test/settlement-math.property.test.ts` |
| Ledger rejects UPDATE/DELETE for tenant role **and** superuser | `test/ledger-append-only.test.ts` |

The idempotency, reversal, and settlement tests are **property tests**
(`fast-check`), not happy-path examples.

## Phase 2 (this repo)

Payments on the operator's **own** Stripe Connect account (destination charges —
we never touch funds), idempotent webhook ingestion into the same append-only
ledger, buyer/consignor reconciliation, and the application-fee billing-base
audit. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §12.

- Config + audit + payments schema: `supabase/migrations/0011_stripe.sql`,
  `0012_payments.sql`
- Webhook verification + ingestion: [`src/stripe/`](src/stripe)

| Requirement | Test |
|---|---|
| Webhook signature verified for real (accept / tamper / wrong secret / missing v1 / stale) | `test/stripe-webhook-signature.test.ts` |
| Duplicate Stripe webhook is physically incapable of double-writing | `test/stripe-ingest.property.test.ts` |
| Buyer/consignor balances reconcile; `record_payment` refuses an org with no Connect account | `test/stripe-ingest.property.test.ts` |
| Application fee collected reconciles against realized ledger fee (billing base) | `test/stripe-ingest.property.test.ts` |

## Phase 3 (this repo)

The fundraising half of the seam: sponsorships (with benefit FMV), donations,
and the **consolidated donor tax receipt** — one receipt per party spanning
sponsor + buyer + donor roles, the query no competitor's split data model can
write. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §13.

- Fundraising + receipts schema: `supabase/migrations/0013_fundraising.sql`,
  `0014_receipts.sql`

| Requirement | Test |
|---|---|
| Deductible = Σ per-line `max(0, paid − FMV)` across sponsorship+donation+auction | `test/tax-receipt.property.test.ts` |
| One party as sponsor+buyer+donor → a single consolidated receipt (3 lines) | `test/tax-receipt-consolidation.test.ts` |
| Fundraising income never inflates the platform billing base (fees only) | `test/tax-receipt.property.test.ts` |
| `lot_award` amounts never drift from the ledger | `test/lot-award-invariant.property.test.ts` |

## Phase 4 (this repo) — Operator Console

A Next.js (App Router) app over the same schema, to make the platform demoable.
It adds no money logic — every figure is a projection the database already
computes, read through the RLS-enforced tenant path (`app/lib/db.ts`). See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §14.

- App: [`app/`](app) — `/orgs`, `/orgs/[orgId]`, `/orgs/[orgId]/events/[eventId]`
- The event view shows realized fees vs. fee collected, parties with their
  *set* of roles (a `multi-role` badge), buyer/consignor balances, and the
  consolidated donor tax receipt — with server-action forms to move the numbers.

### Running the console locally

```bash
npm install
npm run db:start                 # local PG16 on 127.0.0.1:55432
npm run db:migrate               # apply all migrations
npm run db:seed                  # a fully-populated demo operator
npm run dev                      # http://localhost:3000  (visit /orgs)
```

`npm run db:seed` prints a deep link to the demo event. Set `DATABASE_URL_APP`
(app, as `app_user`) and `DATABASE_URL_ADMIN` (platform screen) to point at
another database.

### Deploying (operator-owned)

Vercel + the operator's own Supabase. The app reads `DATABASE_URL_APP` /
`POSTGRES_URL` (Supabase pooler as `app_user`) and an admin URL for the operator
picker. Migrations apply to the operator's own project; a new operator is a new
Supabase project and the same build — no per-operator code. Actual deployment
needs your Vercel + Supabase accounts.

> Not yet wired: authentication (Supabase Auth → the `app.current_org` claim).
> The console currently assumes a trusted operator session.

## Phase 5 (this repo) — Offline venue hub

Events run in venues with no internet. The venue hub (Postgres on a NUC) is
authoritative during the event window; sync is a **replayable monotonic-sequence
op queue**, not a diff. The conflict policy is fixed: **bids are append-only
(never merged, never dropped)**; registrations are last-write-wins. Badges print
as raw ZPL to the Zebra ZD421D's TCP:9100. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §15.

- Queue + conflict policy in SQL: `supabase/migrations/0015_offline.sql`
  (`sync_outbox`, `sync_device_cursor`, `enqueue_op`/`apply_sync_op`, `bid`,
  `registration`)
- Replay + printing: [`src/hub/`](src/hub) (`sync.ts`, `zpl.ts`)

The sync tests run against **two real Postgres databases** (hub + cloud) and
replay the queue between them — no mocks.

| Requirement | Test |
|---|---|
| Bids from many devices sync to exactly the union — never lost, merged, or doubled | `test/offline-sync.property.test.ts` |
| Replay is idempotent; a sequence gap refuses loudly, then heals in order | `test/offline-sync.property.test.ts` |
| Conflicting registrations converge to one winner in either apply order (LWW) | `test/offline-sync.property.test.ts` |
| Bid table rejects UPDATE/DELETE for tenant role and superuser | `test/offline-sync.property.test.ts` |
| Exact ZPL bytes reach a real TCP:9100 listener; names can't inject ZPL | `test/zpl-badge.test.ts` |

## Running the tests

Requires Node 22 and PostgreSQL 16.

```bash
npm install

# Local: start a throwaway PG16 cluster on 127.0.0.1:55432
npm run db:start

npm test

npm run db:stop   # when done
```

The test harness drops and recreates a `eventreg_test` database and applies all
migrations before each run. To point at an existing Postgres instead, set
`DATABASE_URL_MAINT`, `DATABASE_URL_ADMIN`, and `DATABASE_URL_APP` (see
`test/helpers/db.ts`). CI runs the same suite against a `postgres:16` service
container ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## What is deliberately NOT here

Raffles. Regulated charitable gaming (La. R.S. 4:707 / 14:90), pending legal
review — no tables, routes, models, or stubs. The ledger already expresses
party-money-movement generically, so a raffle becomes a module that writes
ledger entries if and when it is cleared. See `docs/ARCHITECTURE.md` §4.4.
