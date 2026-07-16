import type pg from 'pg';

// Ingest an already-signature-verified Stripe event into the ledger. Idempotent
// two ways: the raw event is deduped in stripe_event (UNIQUE org_id+event id),
// and the ledger entry is keyed 'stripe:<event.id>'. Redelivery is a no-op.

export interface IngestResult {
  deduped: boolean; // true if this event.id was already ingested
  ledgerEntryId: string | null;
}

type StripeEvent = {
  id: string;
  type: string;
  data: { object: any };
};

export async function ingestEvent(
  client: pg.Client,
  orgId: string,
  event: StripeEvent,
): Promise<IngestResult> {
  // Record the raw event first. ON CONFLICT DO NOTHING => second delivery is a
  // no-op and we can detect it by whether a row was inserted.
  const recorded = await client.query(
    `insert into stripe_event(org_id, stripe_event_id, type, payload)
     values ($1,$2,$3,$4)
     on conflict (org_id, stripe_event_id) do nothing
     returning id`,
    [orgId, event.id, event.type, event.data.object],
  );
  const deduped = recorded.rowCount === 0;

  let ledgerEntryId: string | null = null;

  switch (event.type) {
    case 'payment_intent.succeeded':
    case 'charge.succeeded': {
      const obj = event.data.object;
      const amount = BigInt(obj.amount_received ?? obj.amount ?? 0);
      const appFee = BigInt(obj.application_fee_amount ?? 0);
      const partyId = obj.metadata?.party_id;
      const internalEventId = obj.metadata?.event_id;
      const destination = obj.transfer_data?.destination ?? null;
      if (!partyId || !internalEventId) {
        throw new Error(`event ${event.id} missing metadata.party_id / metadata.event_id`);
      }
      // record_payment is idempotent on the same key, so even if the stripe_event
      // insert raced, the ledger cannot double-write.
      const res = await client.query(
        'select record_payment($1,$2,$3,$4,$5,$6,$7, now()) as id',
        [
          partyId,
          internalEventId,
          amount.toString(),
          appFee.toString(),
          obj.id,
          destination,
          `stripe:${event.id}`,
        ],
      );
      ledgerEntryId = res.rows[0].id;
      break;
    }
    default:
      // Unhandled event types are still recorded (audit) but write no money.
      break;
  }

  return { deduped, ledgerEntryId };
}
