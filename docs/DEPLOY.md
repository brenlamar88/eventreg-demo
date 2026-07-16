# Deploying the Operator Console (Vercel + Supabase)

The app connects to Postgres with raw `pg` as a **non-superuser role** so
Row-Level Security is enforced on every query. That means three things must be
true in production, or you'll see `Application error: a server-side exception`:

1. the DB connection env vars are set,
2. SSL is on (handled in code — `app/lib/db.ts` enables SSL for any non-local host),
3. the app connects as `app_user` (which needs a password on Supabase).

## 1. Apply migrations to your Supabase project

Via the Supabase GitHub integration (already connected) or:

```bash
supabase link --project-ref <YOUR-REF>
supabase db push
```

This creates every table, RLS policy, and the `app_user` role.

## 2. Give `app_user` a password (one-time, Supabase SQL editor)

`app_user` is created without a password (fine for local trust auth, but
Supabase needs one to connect). Run once:

```sql
alter role app_user with login password '<APP_DB_PASSWORD>';
```

> Do NOT put this password in a migration — it would be committed. Set it in the
> SQL editor and store the value in Vercel env only.

## 3. Set Vercel environment variables

| Var | Value |
|---|---|
| `DATABASE_URL_APP` | `postgres://app_user:<APP_DB_PASSWORD>@<db-host>:5432/postgres` — use the **Session pooler** or direct connection string from Supabase → Project Settings → Database, but swap the role/password to `app_user`. |
| `DATABASE_URL_ADMIN` | The `postgres` role connection string (Supabase gives this). Only used by open-mode/platform screens and org onboarding; optional in a single-operator auth deployment. |
| `NEXT_PUBLIC_SUPABASE_URL` | Your project URL, e.g. `https://<ref>.supabase.co`. (Login only turns on with the flag below.) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The anon key. |
| `NEXT_PUBLIC_AUTH_ENABLED` | Set to `true` to REQUIRE login. Leave unset for open mode. |

**Open mode vs. login.** The Supabase keys alone do **not** turn on login — that
way the one-click Supabase↔Vercel integration (which sets `NEXT_PUBLIC_SUPABASE_*`
and `POSTGRES_URL` for you) lands you in a working **open-mode** site instead of
locking you out before any users exist. Set `NEXT_PUBLIC_AUTH_ENABLED=true` only
once you've created a user and seeded a membership (step 4).

> **Fastest deploy:** add the **Supabase integration** in Vercel (Project →
> Integrations). It injects `POSTGRES_URL` / `POSTGRES_URL_NON_POOLING` and the
> Supabase keys automatically. The app reads `POSTGRES_URL` as a fallback, so it
> comes up in open mode with zero manual string-building. (It connects as the
> `postgres` role that way — do the `app_user` swap above before onboarding real
> multiple operators, so RLS enforces tenant isolation.)

> Use the **Session pooler** (or direct) connection for `DATABASE_URL_APP`, not
> the transaction pooler — `withOrg` runs `BEGIN … set_config … COMMIT` per
> request and wants a stable session.

## 4. Seed the first operator admin

After a user signs up via Supabase Auth, map them to an org:

```sql
select add_member('<auth-user-id>', '<org-id>', 'owner');
```

Get `<org-id>` from `select id, name from org;` (or create one with
`select create_org('Your Association');`).

## Why the raw-`pg`-as-`app_user` design

Supabase's default `postgres` role can bypass RLS — connecting as it would
silently defeat tenant isolation. `app_user` is a plain role with RLS applied,
and `current_org()` reads the org the server derived from the verified Supabase
session. (A future option is to move reads onto `authenticated` via PostgREST;
the schema already supports it — see `docs/ARCHITECTURE.md` §16.)

## Verifying a deploy

Hit `GET /api/health` (no auth required):

```json
{ "status": "ok", "db": "connected",
  "migrations": { "ledger": true, "membership": true, "current_org": true, "billing": true },
  "migrationsApplied": true, "auth": "configured" }
```

- `200 ok` — DB reachable and all migrations applied.
- `503` with `db: "unreachable"` + `dbError` — the connection string / SSL /
  `app_user` password is wrong (the `dbError` says which).
- `503` with `migrationsApplied: false` — connected, but migrations haven't run
  against this database.
- `auth: "open-mode"` means the `NEXT_PUBLIC_SUPABASE_*` vars are unset (no login).

> **After adding the Supabase integration:** env vars apply only to NEW builds.
> If `/api/health` still reports `DATABASE_URL_APP is not set` after connecting
> the integration, trigger a redeploy (Deployments → ⋯ → Redeploy, or push any
> commit) so the build picks them up.
