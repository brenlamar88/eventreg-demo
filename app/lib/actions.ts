'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { withOrg, adminQuery } from './db';
import { seedDemo } from './seed';
import { dollarsToCents } from './format';

function str(form: FormData, key: string): string {
  const v = form.get(key);
  if (typeof v !== 'string' || v.length === 0) throw new Error(`missing field: ${key}`);
  return v;
}

export async function createOrgAction(form: FormData) {
  const name = str(form, 'name');
  await adminQuery('select create_org($1)', [name]);
  revalidatePath('/orgs');
}

export async function seedDemoAction() {
  const { rows } = await adminQuery('select create_org($1) as id', ['Bayou Charitable Auctions']);
  const orgId = rows[0].id as string;
  const { eventId } = await withOrg(orgId, (q) => seedDemo(q, orgId));
  redirect(`/orgs/${orgId}/events/${eventId}`);
}

export async function createEventAction(form: FormData) {
  const orgId = str(form, 'orgId');
  const name = str(form, 'name');
  await withOrg(orgId, (q) =>
    q('insert into event(org_id, name) values ($1,$2)', [orgId, name]),
  );
  revalidatePath(`/orgs/${orgId}`);
}

export async function addPartyAction(form: FormData) {
  const orgId = str(form, 'orgId');
  const eventId = str(form, 'eventId');
  await withOrg(orgId, (q) =>
    q('insert into party(org_id, kind, display_name) values ($1,$2,$3)', [
      orgId,
      str(form, 'kind'),
      str(form, 'name'),
    ]),
  );
  revalidatePath(`/orgs/${orgId}/events/${eventId}`);
}

export async function addLotAction(form: FormData) {
  const orgId = str(form, 'orgId');
  const eventId = str(form, 'eventId');
  const fmv = dollarsToCents(str(form, 'fmv'));
  await withOrg(orgId, (q) =>
    q(
      'insert into lot(org_id, event_id, consignor_party_id, label, fmv_cents) values ($1,$2,$3,$4,$5)',
      [orgId, eventId, str(form, 'consignorId'), str(form, 'label'), fmv.toString()],
    ),
  );
  revalidatePath(`/orgs/${orgId}/events/${eventId}`);
}

export async function postAwardAction(form: FormData) {
  const orgId = str(form, 'orgId');
  const eventId = str(form, 'eventId');
  const hammer = dollarsToCents(str(form, 'hammer'));
  await withOrg(orgId, (q) =>
    q('select post_lot_award($1,$2,$3, now())', [
      str(form, 'lotId'),
      str(form, 'buyerId'),
      hammer.toString(),
    ]),
  );
  revalidatePath(`/orgs/${orgId}/events/${eventId}`);
}

export async function recordDonationAction(form: FormData) {
  const orgId = str(form, 'orgId');
  const eventId = str(form, 'eventId');
  const amount = dollarsToCents(str(form, 'amount'));
  await withOrg(orgId, (q) =>
    q('select record_donation($1,$2,$3,$4,$5, now())', [
      eventId,
      str(form, 'donorId'),
      amount.toString(),
      form.get('designation') || null,
      `ui-don-${crypto.randomUUID()}`,
    ]),
  );
  revalidatePath(`/orgs/${orgId}/events/${eventId}`);
}

export async function recordSponsorshipAction(form: FormData) {
  const orgId = str(form, 'orgId');
  const eventId = str(form, 'eventId');
  const amount = dollarsToCents(str(form, 'amount'));
  const fmv = dollarsToCents(str(form, 'fmv'));
  await withOrg(orgId, (q) =>
    q('select record_sponsorship($1,$2,$3,$4,$5, now())', [
      eventId,
      str(form, 'sponsorId'),
      amount.toString(),
      fmv.toString(),
      `ui-spon-${crypto.randomUUID()}`,
    ]),
  );
  revalidatePath(`/orgs/${orgId}/events/${eventId}`);
}

export async function recordPaymentAction(form: FormData) {
  const orgId = str(form, 'orgId');
  const eventId = str(form, 'eventId');
  const amount = dollarsToCents(str(form, 'amount'));
  const appFee = dollarsToCents(str(form, 'appFee'));
  await withOrg(orgId, async (q) => {
    // demo convenience: ensure the operator has a connected account
    await q(
      "insert into stripe_account(org_id, stripe_account_id) values ($1,'acct_demo') on conflict do nothing",
      [orgId],
    );
    const key = crypto.randomUUID();
    return q('select record_payment($1,$2,$3,$4,$5,$6,$7, now())', [
      str(form, 'buyerId'),
      eventId,
      amount.toString(),
      appFee.toString(),
      `pi_${key}`,
      'acct_demo',
      `stripe:ui-${key}`,
    ]);
  });
  revalidatePath(`/orgs/${orgId}/events/${eventId}`);
}
