import { notFound } from 'next/navigation';
import {
  getOrg,
  getEvent,
  eventBilling,
  buyerAccounts,
  consignorAccounts,
  donorReceipts,
  partiesWithRoles,
  allParties,
  lotsWithStatus,
} from '../../../../lib/queries';
import { usd } from '../../../../lib/format';
import { assertMember } from '../../../../lib/auth';
import { missingDbEnv } from '../../../../lib/db';
import { SetupRequired } from '../../../../components/setup-required';
import {
  addPartyAction,
  addLotAction,
  postAwardAction,
  recordDonationAction,
  recordSponsorshipAction,
  recordPaymentAction,
} from '../../../../lib/actions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROLE_ORDER = ['registrant', 'sponsor', 'bidder', 'buyer', 'consignor', 'donor'];

export default async function EventPage({
  params,
}: {
  params: { orgId: string; eventId: string };
}) {
  const { orgId, eventId } = params;
  const missing = missingDbEnv();
  if (missing.length > 0) return <SetupRequired missing={missing} />;
  await assertMember(orgId); // no-op in open mode; enforces membership with auth on
  const [org, event] = await Promise.all([getOrg(orgId), getEvent(orgId, eventId)]);
  if (!org || !event) notFound();

  const [billing, buyers, consignors, receipts, roles, parties, lots] = await Promise.all([
    eventBilling(orgId, eventId),
    buyerAccounts(orgId, eventId),
    consignorAccounts(orgId, eventId),
    donorReceipts(orgId, eventId),
    partiesWithRoles(orgId, eventId),
    allParties(orgId),
    lotsWithStatus(orgId, eventId),
  ]);

  const reconciled = BigInt(billing.delta_cents) === 0n;
  const unsold = lots.filter((l) => !l.buyer);
  const partyOptions = parties.map((p) => (
    <option key={p.id} value={p.id}>
      {p.display_name}
    </option>
  ));

  return (
    <>
      <p className="crumbs">
        <a href="/orgs">Operators</a> / <a href={`/orgs/${orgId}`}>{org.name}</a> / {event.name}
      </p>
      <h1>{event.name}</h1>
      <p className="sub">Sponsorships, bidding, and consignor settlement — one ledger.</p>

      {/* Billing base — the figure both operator and platform audit */}
      <div className="grid cols-3">
        <div className="card stat">
          <span className="label">Realized fees</span>
          <span className="value accent">{usd(billing.realized_fee_cents)}</span>
          <span className="hint">Buyer&apos;s premium + seller&apos;s commission.</span>
        </div>
        <div className="card stat">
          <span className="label">Application fee collected</span>
          <span className="value">{usd(billing.application_fee_collected_cents)}</span>
          <span className="hint">Via Stripe destination charges.</span>
        </div>
        <div className="card stat">
          <span className="label">Reconciliation</span>
          <span className="value">
            {reconciled ? (
              <span className="badge">✓ reconciled</span>
            ) : (
              <span className="badge warn">Δ {usd(billing.delta_cents)}</span>
            )}
          </span>
          <span className="hint">Realized fee vs. fee collected.</span>
        </div>
      </div>

      {/* The differentiator: one identity, many roles */}
      <h2>Parties &amp; roles</h2>
      {roles.length === 0 ? (
        <div className="card empty">No roles yet.</div>
      ) : (
        <div className="card">
          {roles.map((p) => (
            <div key={p.id} style={{ padding: '6px 0' }}>
              <strong>{p.display_name}</strong>{' '}
              <span className="muted">({p.kind})</span>{' '}
              {[...p.roles]
                .sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b))
                .map((r) => (
                  <span key={r} className="tag role">
                    {r}
                  </span>
                ))}
              {p.roles.length > 1 && <span className="badge" style={{ marginLeft: 6 }}>multi-role</span>}
            </div>
          ))}
        </div>
      )}

      <div className="grid cols-2">
        <div>
          <h2>Buyers</h2>
          <AccountTable
            rows={buyers}
            cols={['invoice_cents', 'paid_cents', 'balance_cents']}
            headers={['Invoice', 'Paid', 'Balance']}
          />
        </div>
        <div>
          <h2>Consignors</h2>
          <AccountTable
            rows={consignors}
            cols={['owed_cents', 'paid_cents', 'balance_cents']}
            headers={['Owed', 'Paid', 'Balance']}
          />
        </div>
      </div>

      {/* Consolidated donor tax receipts across ALL roles */}
      <h2>Donor tax receipts (consolidated across roles)</h2>
      {receipts.length === 0 ? (
        <div className="card empty">No contributions yet.</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Donor</th>
              <th className="num">Contributed</th>
              <th className="num">Benefit FMV</th>
              <th className="num">Tax-deductible</th>
              <th className="num">Lines</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((r) => (
              <tr key={r.display_name}>
                <td>{r.display_name}</td>
                <td className="num">{usd(r.gross_cents)}</td>
                <td className="num">{usd(r.fmv_cents)}</td>
                <td className="num pos">{usd(r.deductible_cents)}</td>
                <td className="num">{r.line_count}</td>
                <td>
                  {r.requires_quid_pro_quo_disclosure && (
                    <span className="badge warn">disclosure req&apos;d</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Lots</h2>
      {lots.length === 0 ? (
        <div className="card empty">No lots yet.</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Lot</th>
              <th>Consignor</th>
              <th className="num">Item FMV</th>
              <th className="num">Hammer</th>
              <th>Buyer</th>
            </tr>
          </thead>
          <tbody>
            {lots.map((l) => (
              <tr key={l.id}>
                <td>{l.label ?? l.id.slice(0, 8)}</td>
                <td>{l.consignor}</td>
                <td className="num">{usd(l.fmv_cents)}</td>
                <td className="num">{l.hammer_cents ? usd(l.hammer_cents) : '—'}</td>
                <td>{l.buyer ?? <span className="muted">unsold</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Actions — make the numbers move for a demo */}
      <h2>Actions</h2>

      <details>
        <summary>Add party</summary>
        <form action={addPartyAction} className="inline">
          <input type="hidden" name="orgId" value={orgId} />
          <input type="hidden" name="eventId" value={eventId} />
          <label className="f">
            Name<input name="name" placeholder="Jane Roe" required />
          </label>
          <label className="f">
            Kind
            <select name="kind">
              <option value="person">person</option>
              <option value="org">org</option>
            </select>
          </label>
          <button type="submit">Add</button>
        </form>
      </details>

      <details>
        <summary>Add lot</summary>
        <form action={addLotAction} className="inline">
          <input type="hidden" name="orgId" value={orgId} />
          <input type="hidden" name="eventId" value={eventId} />
          <label className="f">
            Label<input name="label" placeholder="Napa Getaway" required />
          </label>
          <label className="f">
            Consignor
            <select name="consignorId" required>
              {partyOptions}
            </select>
          </label>
          <label className="f">
            Item FMV<input name="fmv" placeholder="1500.00" required />
          </label>
          <button type="submit">Add lot</button>
        </form>
      </details>

      <details>
        <summary>Post lot award (sell a lot)</summary>
        <form action={postAwardAction} className="inline">
          <input type="hidden" name="orgId" value={orgId} />
          <input type="hidden" name="eventId" value={eventId} />
          <label className="f">
            Lot
            <select name="lotId" required>
              {unsold.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label ?? l.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label className="f">
            Buyer
            <select name="buyerId" required>
              {partyOptions}
            </select>
          </label>
          <label className="f">
            Hammer<input name="hammer" placeholder="2000.00" required />
          </label>
          <button type="submit">Post award</button>
        </form>
      </details>

      <details>
        <summary>Record donation</summary>
        <form action={recordDonationAction} className="inline">
          <input type="hidden" name="orgId" value={orgId} />
          <input type="hidden" name="eventId" value={eventId} />
          <label className="f">
            Donor
            <select name="donorId" required>
              {partyOptions}
            </select>
          </label>
          <label className="f">
            Amount<input name="amount" placeholder="1000.00" required />
          </label>
          <label className="f">
            Designation<input name="designation" placeholder="Fund-a-Need" />
          </label>
          <button type="submit">Record</button>
        </form>
      </details>

      <details>
        <summary>Record sponsorship</summary>
        <form action={recordSponsorshipAction} className="inline">
          <input type="hidden" name="orgId" value={orgId} />
          <input type="hidden" name="eventId" value={eventId} />
          <label className="f">
            Sponsor
            <select name="sponsorId" required>
              {partyOptions}
            </select>
          </label>
          <label className="f">
            Amount<input name="amount" placeholder="5000.00" required />
          </label>
          <label className="f">
            Benefit FMV<input name="fmv" placeholder="600.00" required />
          </label>
          <button type="submit">Record</button>
        </form>
      </details>

      <details>
        <summary>Record payment (simulate Stripe)</summary>
        <form action={recordPaymentAction} className="inline">
          <input type="hidden" name="orgId" value={orgId} />
          <input type="hidden" name="eventId" value={eventId} />
          <label className="f">
            Buyer
            <select name="buyerId" required>
              {partyOptions}
            </select>
          </label>
          <label className="f">
            Amount<input name="amount" placeholder="2300.00" required />
          </label>
          <label className="f">
            App fee<input name="appFee" placeholder="500.00" required />
          </label>
          <button type="submit">Record payment</button>
        </form>
      </details>
    </>
  );
}

function AccountTable({
  rows,
  cols,
  headers,
}: {
  rows: Record<string, string>[];
  cols: string[];
  headers: string[];
}) {
  if (rows.length === 0) return <div className="card empty">No accounts yet.</div>;
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Party</th>
          {headers.map((h) => (
            <th key={h} className="num">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{r.display_name}</td>
            {cols.map((c) => {
              const isBalance = c.endsWith('balance_cents');
              const cls = isBalance && BigInt(r[c]) === 0n ? 'num pos' : 'num';
              return (
                <td key={c} className={cls}>
                  {usd(r[c])}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
