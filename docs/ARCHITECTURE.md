# V8 Event Platform — Architecture

Status: **DRAFT for review.** Written after Topic-1 interview (party identity /
merge / representation). Remaining topics decided by best judgment against
real-world settlement, fundraising, and auction products, with the reasoning
made explicit so you can veto any call. Nothing in this document is built yet.

---

## 0. Finding that changes the brief: this is greenfield

The mission says "productizing the existing `eventreg` codebase in this repo."
**There is no such codebase here.** `main` and this branch each contain one
commit and a 15-byte `README.md`. There is nothing to migrate, nothing that
"won't survive the model," and — importantly — **nothing to backfill.**

Consequence for Phase 1's definition of done: *"existing event backfilled as
org #1"* has no source data. Org #1 becomes simply *the first row created by the
exact same code path that creates org #2* — which is a stronger proof of the
"no forking" rule than a backfill would have been. If a real `eventreg`
instance exists elsewhere (another repo, a Supabase project, a SQL dump), point
me at it and I will add a true backfill path. **Open question O1.**

---

## 1. The product, in one paragraph

Associations run large consignment auctions as fundraisers. Today they must buy
*two* systems: a fundraising platform (OneCause, Handbid, GiveSmart) that does
sponsorships and donor receipting but **cannot settle consignors**, and a
commercial auction platform (AuctionFlex, Wavebid, HiBid) that settles
consignors but **cannot do sponsorships or fundraising**. No product spans the
seam because no product's *data model* can express one human being a sponsor, a
bidder, a buyer, and a consignor at the *same event*. That seam is the product.

---

## 2. Architectural thesis (accepted, with one sharpening)

> Every module is money moving to or from a **party**. Modules *write* ledger
> entries; reporting *reads* them; nothing computes money outside the ledger.

Accepted. The sharpening from the interview: the thesis is only true if the
**party outlives the event** and identity survives merges without ever mutating
a posted entry. Sections 3–4 make that hold.

**Verdict on the `role_at_event` abstraction (you asked me to challenge it):**
it is the *right* abstraction, and it is the one thing competitors structurally
cannot copy — their bidder record, donor record, and consignor record are
separate root entities, so "same person, four roles" is unrepresentable for
them. The only place it strains is role-specific *attributes* (a consignor has a
commission schedule; a bidder has a paddle number). Handled in §5: attributes
live in typed satellite tables, not a soft JSON blob, because they are settled
on and must be queryable.

---

## 3. Party model

### 3.1 Identity anchor

- **`party` is scoped to the org, not the event.** Cross-event history (repeat
  donors, repeat consignors) is the whole value; an event-scoped party throws it
  away.
- **`role_at_event` is the event-scoped junction** linking a party to an event
  with a role. One party + one event + N roles = N rows.

### 3.2 Person vs org is a relationship, not a column (Topic-1 decision C)

```
party
  id            uuid pk
  org_id        uuid  not null            -- tenant
  kind          enum('person','org')
  display_name  text
  merged_into   uuid null references party(id)   -- §3.4
  ...contact/identity columns
```

A `party` may **act on behalf of** another party:

```
party_representation
  org_id            uuid not null
  agent_party_id    uuid references party(id)   -- the person (Jim)
  principal_party_id uuid references party(id)  -- the org (the Foundation)
  ...effective window
```

This lets a *person* hold a `role_at_event` while the *money* names the *org*.

### 3.3 Who the ledger names (representation → obligor)

When Jim, acting for the Boudreaux Foundation, wins a lot: the **buyer invoice
is owed by the Foundation** (the obligor). The ledger entry's `party_id` is the
**Foundation**; Jim is recorded on the *transaction* (the acting party / payment
method), never as the entry's party. Rationale: this is the Stripe model — a
charge belongs to the Customer, the card belongs to whoever tapped it. Naming
the tapper would fragment every settlement total across humans.

### 3.4 Merge = pointer, never a rewrite (Topic-1 decision B → option 1)

Two `party` rows that turn out to be one human (typo'd email at the door vs.
paddle #47 with no email) are reconciled by setting `merged_into` on the
absorbed row to the survivor. **Ledger entries never change `party_id`.**

- Real ledger systems (Stripe Ledger, Modern Treasury, any double-entry book)
  hold posted entries immutable and resolve identity via an alias/link. We copy
  that.
- Operators have used QuickBooks "merge customers" and OneCause "combine
  guests," which *present* merge as one combined history. We give them that view
  by resolving **through** the pointer chain in every report and lookup.
- The merge is **reversible** (unset the pointer). A destructive re-point is
  not, and doing it mid-event on a settlement row is the lawsuit case.

**Costs accepted, written down so they are not surprises:** every
"owes / is owed" query resolves party through the `merged_into` chain (bounded
depth, chase to the root); a badge reprint after a merge resolves to the
surviving party. Chain resolution is a small view/function, applied everywhere
party is read.

---

## 4. Ledger

### 4.1 Shape

```
ledger_entry
  id              uuid pk
  org_id          uuid not null
  event_id        uuid not null
  party_id        uuid not null references party(id)   -- the obligor (§3.3)
  role            enum(... §5)                          -- role money moved under
  entry_type      enum('hammer','buyers_premium','sellers_commission',
                       'sponsorship','donation','payment','payout')
                       -- no 'reversal': a reversal inherits the type it reverses (§4.3)
  amount_cents    bigint not null      -- INTEGER cents; signed; never float
  currency        text not null default 'usd'
  idempotency_key text not null
  reverses_id     uuid null references ledger_entry(id) -- §4.3
  acting_party_id uuid null references party(id)         -- the human who acted
  source          text                 -- 'stripe' | 'venue_hub' | 'operator' ...
  posted_at       timestamptz not null
  UNIQUE (org_id, idempotency_key)      -- §4.2, enforced at DB level
```

Money rules, mapped:
1. **Integer cents.** `amount_cents bigint`. No float type appears near money,
   in schema, code, or transport.
2. **Append-only.** No `UPDATE`/`DELETE` on `ledger_entry`. Enforced by a
   trigger *and* by RLS grants (no update/delete privilege), not by convention.
3. **Idempotency unique at the DB level.** `UNIQUE (org_id, idempotency_key)`.
   A duplicate Stripe webhook physically cannot insert a second row — the second
   insert violates the constraint and is swallowed as a no-op.
4. Rates versioned/effective-dated (§6).
5. Settlement math (§7).

### 4.2 Idempotency-key *grain* (Topic 3)

The key is a single deterministic string the producer constructs; the DB
enforces uniqueness. Grain = **one key per external occurrence that can retry:**

- Stripe webhook → the Stripe `event.id`.
- A bid synced from the venue hub → `bid:{device_id}:{device_seq}` (§8).
- A lot award → `award:{lot_id}:{buyer|consignor}:{hammer|premium|commission}`
  (lot_id is a uuid, so one award posts four deterministically-keyed rows).
- An operator manual entry → `manual:{uuid-minted-once-in-the-UI}`.

The producer owns key construction; the constraint is the backstop. Two
producers must never be able to mint the same key for different money — keys are
namespaced by `source` prefix as above.

### 4.3 Corrections are reversing entries (money rule 2)

A correction inserts a new row that **inherits the original's `entry_type` and
`role`**, sets `reverses_id` to the original, and stores `amount_cents` = the
exact negation. (There is deliberately **no** `'reversal'` `entry_type`:
inheriting the type/role means every type- or role-scoped projection in §7 nets
automatically, with no special-casing of reversals.) The reversal is itself
idempotent: its key is derived, `reverse:{original_idempotency_key}`, so a
retried correction cannot double-reverse. Net of any entry and its reversal is
provably zero — a property test, not an example (§9).

### 4.4 Why raffles need *nothing* here (you asked)

A raffle is money moving to/from a party under some role — which the ledger
*already* expresses with zero raffle-specific structure. So the ledger
"anticipates" raffles for free, and that is the correct amount of anticipation:
**no raffle tables, routes, models, enums, or stubs.** When La. R.S. 4:707 /
14:90 legal review clears, a raffle becomes a *module that writes ledger
entries* (and one new `entry_type`/`role` value at most) — not a schema change
and never a fork. Building anything now would be dead regulated-gaming surface
area. Building nothing is both the instruction and the right call.

---

## 5. `role_at_event` and role attributes

```
role_at_event
  id        uuid pk
  org_id    uuid not null
  event_id  uuid not null
  party_id  uuid not null references party(id)
  role      enum('registrant','sponsor','bidder','buyer','consignor','donor')
  UNIQUE (org_id, event_id, party_id, role)
```

Role-specific attributes live in **typed satellite tables** keyed to the role
row — not a JSON blob — because they are settled on and queried:

- `consignor_terms(role_at_event_id, rate_schedule_id, payout_destination …)`
- `bidder_registration(role_at_event_id, paddle_number, card_on_file …)`
- `sponsor_commitment(role_at_event_id, level, committed_amount_cents …)`

**Buyer "invoice" and consignor "payout" are NOT tables — they are projections
over the ledger** (§7). Storing them would be computing money outside the
ledger, which the thesis forbids.

**On the role enum vs. "no forking":** the six roles are universal to
consignment-auction fundraisers, so hardcoding them is safe and is *not* a fork
— the no-forking rule governs **operators** (operator #2 = a config row, never a
code change), not the closed vocabulary of roles. Honest boundary: if a future
operator genuinely needs a seventh role, that is a rare, additive migration, not
a per-operator fork. I am calling the enum closed for now. **Assumption A1** —
tell me if any real operator you have already needs a role outside these six.

---

## 6. Rates: versioned, effective-dated, per event (money rule 4)

```
rate_schedule
  id            uuid pk
  org_id        uuid not null
  event_id      uuid not null
  kind          enum('buyers_premium','sellers_commission')
  effective_at  timestamptz not null
  -- structure general enough for how AuctionFlex/Wavebid actually bill:
  --   flat percent, OR tiered by hammer band, OR per-consignor override
  ...tier rows / percent in basis points (integer)
```

- Rates are **never global config** and never mutated. A change is a *new*
  `rate_schedule` row with a later `effective_at`. A prior settlement resolves
  the schedule that was effective at *its* post time, so a rate change **cannot
  retroactively alter a closed settlement.**
- Percentages stored as **integer basis points**, never floats.
- The table is general enough for flat, tiered-by-hammer-band, and
  per-consignor override, because commercial auction platforms bill all three.
  **Assumption A2:** I am designing for all three structures rather than asking
  you to pick one now; the *values* are operator-editable config rows. Veto if
  your operator's contract is strictly flat and you want the surface smaller.

---

## 7. Settlement math (money rule 5)

Computed *from* the ledger, as projections:

```
buyer_invoice(party, event)    = Σ hammer      + Σ buyers_premium
consignor_payout(party, event) = Σ hammer      − Σ sellers_commission
operator_revenue(event)        = Σ buyers_premium + Σ sellers_commission
```

- `buyers_premium = hammer × buyers_premium_rate`, computed in integer cents
  with an explicitly specified rounding rule applied per lot (banker's vs.
  half-up — **Assumption A3: half-up per lot**, the auction-industry default;
  called out because rounding is exactly where property tests bite).
- `sellers_commission = hammer × sellers_commission_rate`, same discipline.
- These are **property-tested, not example-tested** (§9).

### 7.1 Realized-fee live figure (your billing base)

`operator_revenue` (Σ buyers_premium + Σ sellers_commission) is a **single live
projection over the ledger**, visible identically to operator and to you.
Because it reads the same append-only rows both parties can audit, it is
auditable at any instant and cannot drift from what was actually charged — it
*is* the sum of realized-fee ledger entries, not a parallel tally.

---

## 8. Multi-tenancy (Phase 1 core)

- **`org_id` on every table**, including `ledger_entry`, `party`, `role_at_event`,
  every satellite, every rate row.
- **Row-Level Security at the row level**, keyed on `org_id`, on every table —
  the isolation boundary is the database, not the application.
- The ledger's no-update/no-delete guarantee is *also* an RLS grant, so even a
  compromised app role cannot mutate a posted entry.
- **No forking.** Onboarding operator #2 is an `INSERT` into `org` plus config
  rows. If it ever needs a code change, the design is wrong and this document is
  wrong.

---

## 9. Phase 1 — scope and definition of done

**Scope:** party model + ledger + multi-tenancy. `org_id` through the schema,
RLS at the row level, org #1 created by the same path as any other org.

**Tests are written first and become the contractual acceptance criteria:**

1. **Second org via SQL is fully functional, fully isolated, empty.** A second
   org is created by the same code path; it can transact end-to-end and shares
   no data with org #1.
2. **Zero cross-org leakage on every table.** A test enumerates every table and
   proves, under RLS, that org A's session cannot read, write, update, or delete
   any org B row.
3. **Ledger cannot double-write on duplicate idempotency key** — property test:
   for arbitrary entries and arbitrary retry multiplicities, the row count and
   net equal the single-write case.
4. **Reversing entries always net correctly** — property test: for any entry and
   its reversal, and any interleaving/retry, the net is exactly zero and no
   original row was mutated.

---

## 10. Offline (context for Phase 1 schema; built later)

Recorded now because it constrains the ledger's key grain (§4.2), not built in
Phase 1:

- Venue hub = Postgres on a NUC, **authoritative during the event window**;
  cloud authoritative outside it. iPads on LAN.
- Sync is a **replayable monotonic-sequence queue**, not a diff. Each device
  emits a monotonic `device_seq`; entries replay in order; keys are
  `{device_id}:{device_seq}`, so replay is idempotent against §4.2.
- Conflict policy is **fixed**: registrations **last-write-wins**; bids
  **append-only, never merged, never dropped** — a lost bid is a lawsuit, so
  bids are ledger-shaped from the start.
- Zebra ZD421D badge printing via **raw ZPL to TCP:9100**.

---

## 11. Open questions & assumptions (please rule on these)

| id | type | resolution |
|----|------|-----------------|
| O1 | RESOLVED | **Build from scratch.** `eventreg` lives in another repo and is not migrated. Org #1 is simply the first org created by the same path as any other org — no backfill. Product goal is to sell to multiple operators, so the create-org path *is* the product, not a one-off. |
| A1 | RESOLVED | Role enum **closed at the six listed.** A seventh is a rare additive migration, never a per-operator fork. |
| A2 | RESOLVED | Rate table **kept general** (flat + tiered + per-consignor override). Multi-operator resale requires it; the values are operator-editable config. |
| A3 | RESOLVED | Per-lot rounding = **half-up** (auction default), baked into the settlement property tests. |

Signed off to proceed to **Phase 1** (party model + ledger + multi-tenancy),
tests first, then the schema + RLS to satisfy them.

---

## 12. Phase 2 — Payments (Stripe Connect, destination charges)

Phase 1 records *obligations* (buyer invoices, consignor payouts, realized fees).
Phase 2 makes money actually move — on the **operator's own** Stripe account,
never ours — and books what happened back into the same append-only ledger.

### 12.1 We never touch funds (contractual)

- Each operator connects **their own** Stripe Connect account. It is a config
  row (`stripe_account`), one per org — no fork.
- All charges are **destination charges**: the platform creates the
  PaymentIntent with `transfer_data.destination = <operator acct>` and an
  `application_fee_amount` = our realized fee. Funds settle into the operator's
  balance; we only ever receive the application fee. The platform never holds
  operator money.
- Consequence enforced in code: `record_payment` **refuses** to book a
  collection for an org with no `stripe_account` — you cannot take money without
  the operator's own Connect account behind it.

### 12.2 The application fee IS the billing base

`application_fee_amount` on the destination charge is, by construction, the
platform's cut. It must equal `operator_revenue` (Σ premium + Σ commission) from
§7.1 — the same realized-fee figure both parties audit. Phase 2 adds
`v_platform_billing(org, event)` exposing `realized_fee_cents`,
`application_fee_collected_cents`, and their `delta`. **A non-zero delta is a
billing bug**, and a property test drives it to zero across arbitrary auctions.

### 12.3 Webhooks: a duplicate is physically incapable of double-writing

- Stripe delivers webhooks **at least once**; retries and duplicates are normal.
- Ingestion is two guards deep: the raw event is recorded in `stripe_event`
  with `UNIQUE (org_id, stripe_event_id)`, and the ledger `payment`/`payout`
  entry it produces is keyed `idempotency_key = 'stripe:' || event.id`, hitting
  the §4.2 `UNIQUE (org_id, idempotency_key)`. Either way, redelivery is a no-op.
- **Signatures are verified for real**, not stubbed: HMAC-SHA256 over
  `"{timestamp}.{payload}"` against the endpoint's signing secret, constant-time
  compare, timestamp tolerance to defeat replay. An unsigned or tampered body is
  rejected before it can touch the ledger. (`src/stripe/webhook.ts`.)

### 12.4 Reconciliation (money moved vs. money owed)

Payments are ledger entries, not a side table of truth:
- `payment` entry: `role='buyer'`, `entry_type='payment'`, **negative** amount
  (reduces what the buyer owes). `v_buyer_account` = invoice − paid = balance.
- `payout` entry: `role='consignor'`, `entry_type='payout'`, negative amount
  (reduces what we owe the consignor). `v_consignor_account` = owed − paid.
- `v_buyer_invoice` is redefined to sum only the **charge** types
  (`hammer` + `buyers_premium`) so it stays gross once payments exist; balance
  lives in `v_buyer_account`. Phase 1's settlement tests are unaffected (no
  payments present in them).

### 12.5 What Phase 2 does NOT do

No card data, no PCI surface (Stripe Elements/Checkout on the operator's front
end handles that), no funds custody, and no charge *creation* here — creation is
an operator-side edge function; this layer verifies, ingests, and reconciles.
Payout *initiation* (operator clicking "pay consignors") is deferred; Phase 2
records payouts that occurred.

### 12.6 Phase 2 definition of done (executable)

- A duplicate Stripe webhook (same `event.id`), delivered any number of times,
  yields exactly one ledger entry and one `stripe_event` row (property test).
- Webhook signature verification accepts a correctly signed body and rejects
  tampered payloads, wrong secrets, missing `v1`, and stale timestamps.
- `record_payment` refuses an org with no connected account.
- `v_buyer_account` / `v_consignor_account` balances are correct across
  arbitrary auctions + partial/over payments (property test).
- `v_platform_billing.delta = 0` when application fees equal realized fees, and
  is detectably non-zero otherwise (property test).

---

## 13. Phase 3 — Fundraising (sponsorships, donations, consolidated receipts)

The other half of the seam. Competitors do this half *or* consignor settlement,
never both, because their sponsor/donor/buyer records are separate root
entities. Here they are the same `party` writing to the same ledger, so the
payoff is a **single consolidated tax receipt** spanning every role — the thing
no split data model can produce.

### 13.1 Contributions are ledger entries

- `sponsorship` → ledger `role='sponsor'`, `entry_type='sponsorship'`. A
  sponsorship carries a **benefit FMV** (fair market value of what the sponsor
  gets back — table, logo, tickets).
- `donation` → ledger `role='donor'`, `entry_type='donation'`. A pure gift; FMV
  of benefits is zero (fully deductible).
- Auction purchases already exist (Phase 1). A `lot` now carries `fmv_cents`
  (retail value of the item), and awarding a lot writes a `lot_award` row
  linking buyer→lot with the posted amounts.

Sponsorships and donations are the operator's income but are **not** the
platform's billing base: `v_operator_revenue` / `v_platform_billing` still count
only `buyers_premium` + `sellers_commission`, so fundraising never inflates my
invoice. (Property-tested.)

### 13.2 The consolidated donor tax receipt (the differentiator)

For U.S. charities the deductible amount of a **quid pro quo** contribution is
`amount paid − FMV of goods/services received` (IRS Pub. 1771); pure gifts are
fully deductible; contributions over **$75** with benefits require a written
disclosure of the deductible portion.

`v_tax_receipt_line` derives one line per contribution across all three sources,
each with `gross_cents`, `fmv_cents`, and
`deductible_cents = max(0, gross − fmv)` (floored **per line** — a bargain on one
item cannot erase deductibility on another):

| source | gross | fmv |
|---|---|---|
| sponsorship | committed amount | benefit FMV |
| donation | gift amount | 0 |
| auction | hammer + buyer's premium paid | lot FMV |

`v_donor_tax_receipt` sums those lines **per party per event**, so one party who
sponsored *and* bought lots *and* donated gets exactly one receipt row with the
correct total deductible and a `requires_quid_pro_quo_disclosure` flag. This is
the query no competitor can write.

### 13.3 `lot_award`: a denormalization with a checked invariant

`lot_award` stores the awarded amounts (hammer, premium, commission) alongside
the buyer→lot link, so receipts can compute per-lot deductibility without
key-parsing. The ledger remains the money source of truth; a **property test
asserts `lot_award` amounts always equal the corresponding ledger entries**, so
the denormalization can never silently drift. Assumption **A4**: an auction
purchase's deductible portion = total paid (hammer + premium) − item FMV — the
standard gala treatment; flag if your CPA wants premium excluded.

### 13.4 Phase 3 definition of done (executable)

- Receipt totals equal the per-line sum of `max(0, gross − fmv)` across arbitrary
  mixes of sponsorships, donations, and auction wins (property test).
- One party holding sponsor + buyer + donor roles at an event yields exactly one
  `v_donor_tax_receipt` row consolidating all three (and three receipt lines).
- `lot_award` amounts equal the ledger's award entries (property test).
- Donations/sponsorships do not change `v_platform_billing` (billing base is
  fees only).
