import { redirect } from 'next/navigation';
import { listOrgs } from '../lib/queries';
import { usd } from '../lib/format';
import { createOrgAction, seedDemoAction } from '../lib/actions';
import { supabaseConfigured } from '../lib/supabase/env';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function OrgsPage() {
  // The cross-tenant platform list is open-mode only. With auth on, operators
  // are scoped to their own org (root redirects them there).
  if (supabaseConfigured()) redirect('/');
  const orgs = await listOrgs();

  return (
    <>
      <h1>Operators</h1>
      <p className="sub">
        Each operator is one tenant row — fully isolated by row-level security. A new
        operator is a config row, never a fork.
      </p>

      {orgs.length === 0 ? (
        <div className="card empty">No operators yet. Seed the demo or create one below.</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Operator</th>
              <th className="num">Realized fees (billing base)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.id}>
                <td>{o.name}</td>
                <td className="num">{usd(o.realized_fee_cents)}</td>
                <td className="num">
                  <a href={`/orgs/${o.id}`}>Open →</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="grid cols-2" style={{ marginTop: 20 }}>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>One-click demo</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Creates a fully populated operator: one gala with a party who is sponsor,
            buyer, and donor at once — then jumps to their event.
          </p>
          <form action={seedDemoAction}>
            <button type="submit">Seed demo operator</button>
          </form>
        </div>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>New operator</h2>
          <form action={createOrgAction} className="inline">
            <label className="f">
              Name
              <input name="name" placeholder="Acadiana Arts Guild" required />
            </label>
            <button type="submit">Create</button>
          </form>
        </div>
      </div>
    </>
  );
}
