import 'server-only';
import { withOrg, adminQuery } from './db';

// Cross-tenant: the org picker is the one screen that intentionally lists all
// operators. Everything else goes through withOrg (RLS-scoped).
export async function listOrgs() {
  const { rows } = await adminQuery(
    `select o.id, o.name,
            coalesce(sum(b.realized_fee_cents), 0)::text as realized_fee_cents
       from org o
       left join v_platform_billing b on b.org_id = o.id
      group by o.id, o.name
      order by o.name`,
  );
  return rows as { id: string; name: string; realized_fee_cents: string }[];
}

export async function getOrg(orgId: string) {
  return withOrg(orgId, async (q) => {
    const { rows } = await q('select id, name from org where id = $1', [orgId]);
    return rows[0] as { id: string; name: string } | undefined;
  });
}

export async function orgRealizedFee(orgId: string) {
  return withOrg(orgId, async (q) => {
    const { rows } = await q(
      'select coalesce(sum(realized_fee_cents),0)::text as fee from v_platform_billing',
    );
    return rows[0].fee as string;
  });
}

export async function listEvents(orgId: string) {
  return withOrg(orgId, async (q) => {
    const { rows } = await q(
      `select e.id, e.name,
              coalesce(b.realized_fee_cents, 0)::text as realized_fee_cents,
              (select count(*)::int from role_at_event r where r.event_id = e.id) as role_count
         from event e
         left join v_platform_billing b on b.event_id = e.id
        order by e.name`,
    );
    return rows as {
      id: string;
      name: string;
      realized_fee_cents: string;
      role_count: number;
    }[];
  });
}

export async function getEvent(orgId: string, eventId: string) {
  return withOrg(orgId, async (q) => {
    const { rows } = await q('select id, name from event where id = $1', [eventId]);
    return rows[0] as { id: string; name: string } | undefined;
  });
}

export async function eventBilling(orgId: string, eventId: string) {
  return withOrg(orgId, async (q) => {
    const { rows } = await q(
      `select coalesce(realized_fee_cents,0)::text as realized_fee_cents,
              coalesce(application_fee_collected_cents,0)::text as application_fee_collected_cents,
              coalesce(delta_cents,0)::text as delta_cents
         from v_platform_billing where event_id = $1`,
      [eventId],
    );
    return (
      rows[0] ?? {
        realized_fee_cents: '0',
        application_fee_collected_cents: '0',
        delta_cents: '0',
      }
    );
  });
}

export async function buyerAccounts(orgId: string, eventId: string) {
  return withOrg(orgId, async (q) => {
    const { rows } = await q(
      `select p.display_name,
              a.invoice_cents::text, a.paid_cents::text, a.balance_cents::text
         from v_buyer_account a
         join party p on p.id = a.party_id
        where a.event_id = $1
        order by a.balance_cents desc`,
      [eventId],
    );
    return rows as {
      display_name: string;
      invoice_cents: string;
      paid_cents: string;
      balance_cents: string;
    }[];
  });
}

export async function consignorAccounts(orgId: string, eventId: string) {
  return withOrg(orgId, async (q) => {
    const { rows } = await q(
      `select p.display_name,
              a.owed_cents::text, a.paid_cents::text, a.balance_cents::text
         from v_consignor_account a
         join party p on p.id = a.party_id
        where a.event_id = $1
        order by a.balance_cents desc`,
      [eventId],
    );
    return rows as {
      display_name: string;
      owed_cents: string;
      paid_cents: string;
      balance_cents: string;
    }[];
  });
}

export async function donorReceipts(orgId: string, eventId: string) {
  return withOrg(orgId, async (q) => {
    const { rows } = await q(
      `select p.display_name,
              r.gross_cents::text, r.fmv_cents::text, r.deductible_cents::text,
              r.line_count, r.requires_quid_pro_quo_disclosure
         from v_donor_tax_receipt r
         join party p on p.id = r.party_id
        where r.event_id = $1
        order by r.deductible_cents desc`,
      [eventId],
    );
    return rows as {
      display_name: string;
      gross_cents: string;
      fmv_cents: string;
      deductible_cents: string;
      line_count: number;
      requires_quid_pro_quo_disclosure: boolean;
    }[];
  });
}

// Parties with the set of roles they hold at this event — the multi-role model
// made visible.
export async function partiesWithRoles(orgId: string, eventId: string) {
  return withOrg(orgId, async (q) => {
    const { rows } = await q(
      `select p.id, p.display_name, p.kind,
              coalesce(array_agg(distinct r.role::text) filter (where r.role is not null), array[]::text[]) as roles
         from party p
         left join role_at_event r on r.party_id = p.id and r.event_id = $1
        group by p.id, p.display_name, p.kind
       having count(r.role) > 0
        order by p.display_name`,
      [eventId],
    );
    return rows as { id: string; display_name: string; kind: string; roles: string[] }[];
  });
}

export async function allParties(orgId: string) {
  return withOrg(orgId, async (q) => {
    const { rows } = await q('select id, display_name, kind from party order by display_name');
    return rows as { id: string; display_name: string; kind: string }[];
  });
}

export async function lotsWithStatus(orgId: string, eventId: string) {
  return withOrg(orgId, async (q) => {
    const { rows } = await q(
      `select l.id, l.label, l.fmv_cents::text,
              c.display_name as consignor,
              la.hammer_cents::text as hammer_cents,
              b.display_name as buyer
         from lot l
         join party c on c.id = l.consignor_party_id
         left join lot_award la on la.lot_id = l.id
         left join party b on b.id = la.buyer_party_id
        where l.event_id = $1
        order by l.label nulls last, l.id`,
      [eventId],
    );
    return rows as {
      id: string;
      label: string | null;
      fmv_cents: string;
      consignor: string;
      hammer_cents: string | null;
      buyer: string | null;
    }[];
  });
}

export async function hasStripeAccount(orgId: string) {
  return withOrg(orgId, async (q) => {
    const { rows } = await q('select 1 from stripe_account limit 1');
    return rows.length > 0;
  });
}
