import type pg from 'pg';

// Connect the operator's own Stripe account (a config row — one per org).
export async function connectStripe(
  c: pg.Client,
  orgId: string,
  acct = 'acct_operator_1',
): Promise<void> {
  await c.query(
    'insert into stripe_account(org_id, stripe_account_id, charges_enabled) values ($1,$2,true)',
    [orgId, acct],
  );
}

// A minimal Stripe `payment_intent.succeeded` event as it would arrive on the
// webhook (already signature-verified). The buyer party and internal event id
// travel in metadata; the destination + application fee model the destination
// charge.
export function paymentIntentSucceeded(opts: {
  eventId: string;
  paymentIntentId: string;
  amountCents: bigint;
  applicationFeeCents: bigint;
  partyId: string;
  internalEventId: string;
  destination?: string;
}): any {
  return {
    id: opts.eventId,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: opts.paymentIntentId,
        object: 'payment_intent',
        amount_received: Number(opts.amountCents),
        application_fee_amount: Number(opts.applicationFeeCents),
        transfer_data: { destination: opts.destination ?? 'acct_operator_1' },
        metadata: { party_id: opts.partyId, event_id: opts.internalEventId },
      },
    },
  };
}
