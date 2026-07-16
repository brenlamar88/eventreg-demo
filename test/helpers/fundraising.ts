import type pg from 'pg';

export async function setLotFmv(c: pg.Client, lotId: string, fmvCents: bigint): Promise<void> {
  await c.query('update lot set fmv_cents = $1 where id = $2', [fmvCents.toString(), lotId]);
}

export async function recordSponsorship(
  c: pg.Client,
  eventId: string,
  sponsorPartyId: string,
  amountCents: bigint,
  benefitFmvCents: bigint,
  key: string,
): Promise<void> {
  await c.query('select record_sponsorship($1,$2,$3,$4,$5, now())', [
    eventId,
    sponsorPartyId,
    amountCents.toString(),
    benefitFmvCents.toString(),
    key,
  ]);
}

export async function recordDonation(
  c: pg.Client,
  eventId: string,
  donorPartyId: string,
  amountCents: bigint,
  key: string,
  designation: string | null = null,
): Promise<void> {
  await c.query('select record_donation($1,$2,$3,$4,$5, now())', [
    eventId,
    donorPartyId,
    amountCents.toString(),
    designation,
    key,
  ]);
}
