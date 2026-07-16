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
                       'sponsorship','donation','payment','payout',
                       'reversal', ...)
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
- A lot award → `award:{event_id}:{lot_id}:{award_seq}`.
- An operator manual entry → `manual:{uuid-minted-once-in-the-UI}`.

The producer owns key construction; the constraint is the backstop. Two
producers must never be able to mint the same key for different money — keys are
namespaced by `source` prefix as above.

### 4.3 Corrections are reversing entries (money rule 2)

A correction inserts a new row with `entry_type='reversal'`, `reverses_id`
pointing at the original, and `amount_cents` = the exact negation of the
original. The reversal is itself idempotent: its key is derived,
`reverse:{original_idempotency_key}`, so a retried correction cannot
double-reverse. Net of any entry and its reversal is provably zero — this is a
property test, not an example (§9).

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

| id | type | needs your call |
|----|------|-----------------|
| O1 | open | Is there a real `eventreg` instance to backfill as org #1, or is org #1 just the first-created org? |
| A1 | assumption | Role enum closed at the six listed — any real operator already needing a seventh? |
| A2 | assumption | Rate table designed for flat + tiered + per-consignor override — keep general, or is your operator strictly flat? |
| A3 | assumption | Per-lot rounding = half-up (auction default). Confirm before it's baked into property tests. |

**Stopping here for your review, per the mission.** On your sign-off (and
answers to O1/A1/A2/A3) I proceed to Phase 1: tests first, then the schema +
RLS to satisfy them.
