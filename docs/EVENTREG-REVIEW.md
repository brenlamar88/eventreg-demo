# eventreg — Full Repo Review & Build-Ready Plan

Reviewed: `brenlamar88/eventreg` @ `cbc0074` (all source read — 6 API functions
by the orchestrator, all React components by a review agent). Combined with the
Cvent research and Wallet/QR implementation research.

## Verdict

**Right foundation, real product.** ~2,900 lines that already do: registration
wizard with Stripe Checkout, a door check-in view with walk-ins (cash + card),
sponsor CRM with tiers, and a genuinely strong auction settlement module
(commission tiers, consignor/buyer ledgers, printable statements, 6-sheet XLSX
export). The visual system (pine/gold/bone, Fraunces/Hanken, ticket stub,
KPI cards) is cohesive — this is the quality bar, and we keep it.

**But three of your four requirements are currently visual promises, not
features** — and knowing that precisely is what makes the plan buildable:

| Requirement | Reality in the code today |
|---|---|
| Sponsorships | Internal CRM tracker (tiers hardcoded, amounts hand-typed). No public purchase, no payment link, benefits are a free-text box. |
| Offline | A status label. `"offline"` = fetch failed, keep in-memory data. No service worker, no IndexedDB, no queue — a refresh loses everything. |
| Self-serve + iPad registration | **Real.** Registration wizard works; Door view has search check-in, walk-in cash/card, bidder auto-numbering. Best part of the app. |
| QR + Wallet ticket | **The QR is fake** — a decorative PRNG dot-grid that encodes nothing. The confirmation code is never saved anywhere. No scanner exists. No email is sent. |

## What we preserve untouched

- The design system and every screen's layout/UX
- Auction settlement domain logic (commission tiers, delivered-gates-check
  workflow, ledgers, XLSX/CSV exports)
- The webhook-as-source-of-truth Stripe architecture (registrant written by the
  signature-verified webhook — correct)
- Door check-in UX (fast search, big targets, flash feedback, walk-in split)
- Security shape: insert-only client key, service-role behind serverless
  functions

## Must-fix defects (found in review, ranked)

1. **Stripe webhook double-writes** — a redelivery inserts a duplicate paid
   registrant (no unique on `stripe_session_id`). One DB constraint + upsert.
2. **`?lot_paid=<id>` marks a lot paid from the URL, unverified** — anyone can
   craft it; and the client-side flip never PATCHes the DB anyway (flag lost on
   reload). Must come only from the webhook.
3. **Index-based mutations race the 20s poll** — check-in/delete by array index
   can hit the *wrong person* if a poll lands mid-tap. Mutate by id.
4. **Walk-in synthetic ids never reconcile** (`wi-<timestamp>`) — later PATCHes
   against them silently vanish.
5. **Silent `catch {}` on money writes** — amountPaid/check# can display
   states the DB never received, with zero feedback.
6. **Float money math** everywhere; commission/net computed in browser, trusted
   by server. (Server-side integer-cents settlement math, property-tested, is
   ready to port from the demo repo.)
7. Guest attendee details are collected in the UI then **discarded** (only the
   lead registrant is saved).
8. Double-click double-insert in simulated pay; bidder-number fetch-max+1 can
   collide across devices.
9. Triplicated theme/CSS + helpers across the three apps (copy-paste drift);
   shared modules needed before features multiply it.

## Phase A (first build): the Ticketing Spine — exact plug-in points

Everything lands in YOUR repo, your look, no rewrite:

1. **DB**: `tickets` table (token = 128-bit base64url, status
   valid/checked_in/void, per-registrant), `ticket_scans` log; unique key on
   `registrants.stripe_session_id` (fixes defect #1).
2. **Mint on payment**: in `api/stripe-webhook.js` — the row insert becomes an
   idempotent upsert + ticket mint + confirmation email (with hosted QR image,
   ticket-page link, both wallet buttons). Simulated/cash paths mint in
   `completeRegistration` / `addCashWalkIn`.
3. **Real QR**: replace the fake `CheckinQR` (BoilOnTheBend.jsx:303) with a
   real encoder rendering the ticket token; confirmation step 3 now shows a
   scannable ticket.
4. **Wallet**: new `api/ticket/[token]/pass.pkpass` (passkit-generator, certs
   in env) + Google Wallet save-link endpoint + public ticket page `/t/<token>`.
5. **Scan check-in**: `@zxing/browser` camera scan in the existing Door view
   (slots beside the search box, line ~660) hitting a new atomic
   `POST /api/scan` (single-statement dedupe: valid→checked_in, else
   duplicate/void/invalid) — replacing the boolean toggle while keeping it as
   manual fallback.

**Phase B** (offline door): IndexedDB ticket manifest + queued scan/mutation
outbox + `/api/scan/batch` reconciliation (first-scan-wins, conflicts surfaced
to staff), service-worker app shell; fix identity/racing defects #3–5 as part
of the same change. This *beats Cvent OnArrival*, which can't do offline
walk-ins and hides sync state.

**Phase C** (sponsorships productized): tiers become data with structured
entitlements (comp tickets/table size auto-linked via existing `sponsor_id`),
public sponsor purchase page reusing the checkout pattern, payment via Stripe
instead of hand-typed amounts, logo upload.

**Phase D** (unified settlement): integer-cents settlement module (ported,
property-tested) behind the existing UI; webhook-verified payment states;
Buyer Ledger becomes the one-bill-per-bidder unified checkout (tickets + lots
+ sponsorship on one balance).

## Needed from you before Phase A code

1. **Go/no-go on this plan** (and confirm Phase A → B → C → D order).
2. **Apple Developer account?** Required for the Wallet pass certificate —
   registration takes a day or two if you don't have one. (QR ticketing ships
   regardless; the pass button turns on when the cert exists.)
3. Where should Phase A land — a branch + PR on `brenlamar88/eventreg`?
   (Recommended; you review before anything merges.)
