# V8 Event Platform — Revised Product Plan

Date: 2026-07-16. Status: **for your approval — no code until you sign off.**

Direction change accepted: **your `eventreg` repo is the foundation.** The
`eventreg-demo` work is demoted to a parts bin — we lift only the pieces that
earn their place (settlement math, Stripe webhook idempotency, multi-event
tenancy when you're ready), and the product surface is rebuilt around YOUR app.

## The four non-negotiables (your words, now acceptance criteria)

1. **Sponsorships** — first-class, tiered, visible.
2. **Offline** — the event does not stop when venue Wi-Fi does.
3. **Registration both ways** — attendee self-serve on the web AND staff/kiosk
   registration on an iPad at the door.
4. **Instant ticket** — every registration gets a QR code and an Apple Wallet
   pass (Google Wallet for Android).

---

## 1. What your eventreg already is (from the live deployment)

Probed `eventreg-eosin.vercel.app` ("Boil on the Bend — EWA-LA", Vite SPA):

- API surface: `/api/registrants`, `/api/sponsors`, `/api/lots`,
  `/api/lot-checkout`, `/api/create-checkout-session` (Stripe Checkout),
  `/api/settings`
- Feature signals in the bundle: sponsor (59), **QR (32)**, **offline (18)**,
  ticket (14), badge (10), check-in — every one of the four requirements is
  already *touched* in this codebase.

**Conclusion:** eventreg is a working single-event product with registration,
Stripe payment, sponsors, lots, and QR/badge/check-in DNA. The plan below
hardens and extends it rather than replacing it.

> **Repo review pending your approval.** The `add_repo` request for
> `brenlamar88/eventreg` needs your click. The moment it lands, review agents
> map the code and this section gains a real audit: what's solid, what's
> fragile, exactly where each feature below plugs in.

## 2. What Cvent does (research summary) — and our wedge

Cvent = Registration builder + OnArrival (iPad check-in) + wallet passes +
exhibitor/sponsor management. Full report available; the parts that matter:

**Worth emulating (top of their ranked list):**
- **Registration TYPES, one flow** — member/non-member/VIP/sponsor types drive
  pricing + question visibility inside a single form (NOT Cvent's confusing
  separate "paths").
- **Offline-first check-in** — OnArrival pre-downloads the event to the iPad;
  check-in, edits, scanning, and badge printing all work offline; queued data
  syncs on reconnect. Their gaps we can beat: **no offline walk-in
  registration, no visible sync state, weak multi-device conflict handling.**
- **One confirmation number = the ticket** — the same QR flows into email,
  wallet pass, and badge, all hitting one check-in pipeline.
- **Native Apple/Google Wallet passes** from the confirmation email.
- **Kiosk mode** with per-kiosk filters (VIP line), locked device, hands-free
  QuickScan; **walk-in register+pay+badge in under a minute**.
- **Sponsor tiers as first-class objects** — tier → logo placement everywhere +
  bundled package (table, tickets, staff regs); lightweight sponsor
  self-service (logo upload).
- **Self-service modify/cancel** via confirmation number — kills the #1
  volunteer support burden.

**Deliberately NOT copying:** the type-vs-path dual abstraction; quote-only
enterprise pricing; the module zoo (Attendee Hub, Abstract Management, RFP…).

**The wedge (their open flank):** Cvent has **no auction engine, no paddle
raise, no donor receipting, no consignment settlement, no unified gala
checkout** — and it costs $20K+/yr. OneCause/Handbid own giving but can't do
consignment settlement. **Cvent-grade check-in polish + OneCause-grade giving +
consignment settlement nobody has = this product.** (Your lots +
`lot-checkout` are already halfway there; the demo repo's tested settlement
math finishes it.)

## 3. Tickets: QR + Apple Wallet (implementation facts, researched)

- **Apple Wallet works serverless on Vercel.** `passkit-generator` v3.5.7
  (active, pure-JS signing), certs base64'd in env vars, served as
  `application/vnd.apple.pkpass`. Skip the pass-update web service in v1
  (passes stay static; the gate enforces validity). **Needs from you: an Apple
  Developer account ($99/yr) to mint the Pass Type ID certificate.**
- **Google Wallet** = service-account JWT "Save to Wallet" links — simpler than
  Apple, but production access needs a ~2-business-day Google review. **Start
  the issuer onboarding early.**
- **QR design:** opaque random token (128-bit, base64url) — never personal
  data. Same token in the email QR, wallet pass, ticket page `/t/[token]`, and
  badge. Email carries a hosted QR image + ticket-page link (survives image
  blocking).
- **iPad scanning:** `@zxing/browser` over `getUserMedia` in **Safari (not a
  standalone PWA — camera permissions break)`; manual code entry fallback.
- **Offline check-in:** ticket manifest synced to IndexedDB (+ app shell via
  service worker), scans validated locally, queued in an outbox, flushed to a
  batch endpoint on reconnect; first-scan-wins; cross-device duplicates
  surfaced to staff as a review list after sync. This design **beats
  OnArrival** by keeping walk-in capture working offline too (card payment
  queued as "collect at settlement" or cash/check recorded).

## 4. The build plan (on top of eventreg)

**Phase A — Ticketing spine (1st build):**
tickets table + token, `/t/[token]` page, QR in confirmation email, Apple
Wallet pass endpoint, Google Wallet link, `/api/scan` + `/api/scan/batch` +
check-in manifest endpoint. Slots directly behind your existing
`/api/registrants` flow.

**Phase B — iPad door station:** check-in screen (scan + search), walk-in
registration (staff mode), kiosk self-serve mode, badge print (your badge code
+ Zebra path from the demo work if useful), offline manifest + outbox.

**Phase C — Sponsorships, productized:** tiers as data (logo, placement,
bundled tickets/table), public sponsor display on event site + kiosk welcome
screen, sponsor self-serve logo upload, sponsorship purchase in registration.

**Phase D — The wedge:** unified end-of-night checkout (auction lots + fees on
one stored card — your `lot-checkout` grown up), consignor settlement +
donor-receipt math imported from the demo repo's property-tested ledger.

Each phase ships behind your review; A is small enough to demo within a day of
repo access.

## 5. What I need from you

1. **Approve the `add_repo` request for `brenlamar88/eventreg`** (blocking the
   code review + all building).
2. **Apple Developer account** — do you have one? (Needed for Wallet certs;
   registration takes a day or two if not.)
3. Confirm the phase order (A→B→C→D) or reorder it.
