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
