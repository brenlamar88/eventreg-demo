import { test, expect, afterAll } from 'vitest';
import fc from 'fast-check';
import { createOrg, orgClient, roundHalfUpBps, closeAll } from './helpers/db.ts';
import { makeAuction, postAward } from './helpers/seed.ts';
import { connectStripe, paymentIntentSucceeded } from './helpers/stripe.ts';
import { ingestEvent } from '../src/stripe/ingest.ts';

afterAll(closeAll);

let seq = 0;
const uniq = (p: string) => `${p}_${++seq}_${crypto.randomUUID().slice(0, 8)}`;

// A duplicate webhook (same event.id), delivered any number of times, must yield
// exactly one ledger payment entry and one stripe_event row.
test('duplicate Stripe webhook is physically incapable of double-writing', async () => {
  const orgId = await createOrg('stripe-idem-org');
  const c = await orgClient(orgId);
  await connectStripe(c, orgId);
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 1n, max: 1_000_000_000n }),
        fc.integer({ min: 1, max: 8 }), // redeliveries
        fc.integer({ min: 0, max: 3000 }),
        fc.integer({ min: 0, max: 3000 }),
        async (hammer, redeliveries, premiumBps, commissionBps) => {
          const ctx = await makeAuction(c, orgId, premiumBps, commissionBps);
          await postAward(c, ctx.lotId, ctx.buyerId, hammer);

          const premium = roundHalfUpBps(hammer, premiumBps);
          const commission = roundHalfUpBps(hammer, commissionBps);
          const invoice = hammer + premium;
          const realizedFee = premium + commission;

          const evt = paymentIntentSucceeded({
            eventId: uniq('evt'),
            paymentIntentId: uniq('pi'),
            amountCents: invoice,
            applicationFeeCents: realizedFee,
            partyId: ctx.buyerId,
            internalEventId: ctx.eventId,
          });

          const results = [];
          for (let i = 0; i < redeliveries; i++) {
            results.push(await ingestEvent(c, orgId, evt));
          }
          // first ingest writes; the rest are deduped no-ops
          expect(results.filter((r) => !r.deduped)).toHaveLength(1);
          expect(results.filter((r) => r.deduped)).toHaveLength(redeliveries - 1);

          const evRows = await c.query(
            'select count(*)::int n from stripe_event where stripe_event_id=$1',
            [evt.id],
          );
          expect(evRows.rows[0].n).toBe(1);

          const payRows = await c.query(
            "select count(*)::int n from ledger_entry where role='buyer' and entry_type='payment' and idempotency_key=$1",
            [`stripe:${evt.id}`],
          );
          expect(payRows.rows[0].n).toBe(1);

          // buyer fully paid => balance zero
          const acct = await c.query(
            'select balance_cents from v_buyer_account where event_id=$1 and party_id=$2',
            [ctx.eventId, ctx.buyerId],
          );
          expect(BigInt(acct.rows[0].balance_cents)).toBe(0n);
        },
      ),
      { numRuns: 30 },
    );
  } finally {
    await c.end();
  }
});

// Reconciliation: buyer balance = invoice − paid across arbitrary partial and
// over-payments, and the platform billing delta stays zero when the application
// fee equals the realized ledger fee.
test('buyer account reconciles and billing delta is zero when fees match', async () => {
  const orgId = await createOrg('stripe-recon-org');
  const c = await orgClient(orgId);
  await connectStripe(c, orgId);
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 1n, max: 1_000_000_000n }),
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 0, max: 120 }), // pay this % of the invoice (partial..over)
        async (hammer, premiumBps, commissionBps, payPct) => {
          const ctx = await makeAuction(c, orgId, premiumBps, commissionBps);
          await postAward(c, ctx.lotId, ctx.buyerId, hammer);

          const premium = roundHalfUpBps(hammer, premiumBps);
          const commission = roundHalfUpBps(hammer, commissionBps);
          const invoice = hammer + premium;
          const realizedFee = premium + commission;
          const paid = (invoice * BigInt(payPct)) / 100n;
          // application fee scales with what was actually collected, staying the
          // platform's proportional cut; when fully paid it equals realizedFee.
          const appFee = (realizedFee * BigInt(payPct)) / 100n;

          if (paid > 0n) {
            await ingestEvent(
              c,
              orgId,
              paymentIntentSucceeded({
                eventId: uniq('evt'),
                paymentIntentId: uniq('pi'),
                amountCents: paid,
                applicationFeeCents: appFee,
                partyId: ctx.buyerId,
                internalEventId: ctx.eventId,
              }),
            );
          }

          const acct = await c.query(
            'select invoice_cents, paid_cents, balance_cents from v_buyer_account where event_id=$1 and party_id=$2',
            [ctx.eventId, ctx.buyerId],
          );
          expect(BigInt(acct.rows[0].invoice_cents)).toBe(invoice);
          expect(BigInt(acct.rows[0].paid_cents)).toBe(paid);
          expect(BigInt(acct.rows[0].balance_cents)).toBe(invoice - paid);

          // billing: application fee collected reconciles against realized fee
          const bill = await c.query(
            'select realized_fee_cents, application_fee_collected_cents, delta_cents from v_platform_billing where event_id=$1',
            [ctx.eventId],
          );
          expect(BigInt(bill.rows[0].realized_fee_cents)).toBe(realizedFee);
          expect(BigInt(bill.rows[0].application_fee_collected_cents)).toBe(appFee);
          expect(BigInt(bill.rows[0].delta_cents)).toBe(realizedFee - appFee);
        },
      ),
      { numRuns: 30 },
    );
  } finally {
    await c.end();
  }
});

// Contractual: you cannot collect money for an org with no connected account.
test('record_payment refuses an org with no Stripe Connect account', async () => {
  const orgId = await createOrg('no-connect-org');
  const c = await orgClient(orgId);
  try {
    const ctx = await makeAuction(c, orgId, 1000, 500);
    await postAward(c, ctx.lotId, ctx.buyerId, 100_000n);
    // no connectStripe() call
    await expect(
      ingestEvent(
        c,
        orgId,
        paymentIntentSucceeded({
          eventId: uniq('evt'),
          paymentIntentId: uniq('pi'),
          amountCents: 100_000n,
          applicationFeeCents: 15_000n,
          partyId: ctx.buyerId,
          internalEventId: ctx.eventId,
        }),
      ),
    ).rejects.toThrow(/connect|stripe account/i);
  } finally {
    await c.end();
  }
});
