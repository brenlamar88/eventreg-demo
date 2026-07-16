import { notFound } from 'next/navigation';
import { getOrg, orgRealizedFee, listEvents } from '../../lib/queries';
import { usd } from '../../lib/format';
import { createEventAction } from '../../lib/actions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function OrgDashboard({ params }: { params: { orgId: string } }) {
  const org = await getOrg(params.orgId);
  if (!org) notFound();
  const [fee, events] = await Promise.all([
    orgRealizedFee(params.orgId),
    listEvents(params.orgId),
  ]);

  return (
    <>
      <p className="crumbs">
        <a href="/orgs">Operators</a> / {org.name}
      </p>
      <h1>{org.name}</h1>
      <p className="sub">Operator dashboard</p>

      <div className="grid cols-3">
        <div className="card stat">
          <span className="label">Realized fees — all events</span>
          <span className="value accent">{usd(fee)}</span>
          <span className="hint">Buyer&apos;s premium + seller&apos;s commission. Your billing base.</span>
        </div>
        <div className="card stat">
          <span className="label">Events</span>
          <span className="value">{events.length}</span>
        </div>
        <div className="card stat">
          <span className="label">Role assignments</span>
          <span className="value">{events.reduce((n, e) => n + e.role_count, 0)}</span>
          <span className="hint">One party can hold several roles per event.</span>
        </div>
      </div>

      <h2>Events</h2>
      {events.length === 0 ? (
        <div className="card empty">No events yet. Create one below.</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Event</th>
              <th className="num">Roles</th>
              <th className="num">Realized fees</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{e.name}</td>
                <td className="num">{e.role_count}</td>
                <td className="num">{usd(e.realized_fee_cents)}</td>
                <td className="num">
                  <a href={`/orgs/${org.id}/events/${e.id}`}>Open →</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <details>
        <summary>New event</summary>
        <form action={createEventAction} className="inline">
          <input type="hidden" name="orgId" value={org.id} />
          <label className="f">
            Name
            <input name="name" placeholder="Fall Benefit 2026" required />
          </label>
          <button type="submit">Create event</button>
        </form>
      </details>
    </>
  );
}
