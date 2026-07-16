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
