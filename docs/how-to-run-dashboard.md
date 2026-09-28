# How to run the dashboard locally

This gets `apps/dashboard` (shadcn/ui, lime theme) talking to a real, running `apps/api` on your
machine — no fake data, no mocked endpoints. Commands are PowerShell; run each block from the repo
root (`E:\APPLICATIONS\Hisaab`) unless told otherwise.

Until now `apps/api/src/index.ts` only validated its environment at boot — it never called
`.listen()` (issues #2/#3). This branch wires the real bootstrap, so `pnpm dev` for the API now
starts a real server for the first time.

## 1. Start the local infrastructure

```powershell
docker compose up -d
docker compose ps   # postgres, clickhouse, redis-durable, redis-cache should all be "healthy"
```

## 2. Install dependencies and run migrations

```powershell
pnpm install
pnpm db:migrate
```

## 3. Set up your `.env`

Copy the template if you don't already have one:

```powershell
Copy-Item .env.example .env
```

`.env.example` only covers the M0-2 infra vars (Postgres/ClickHouse/Redis/ports). The API now
needs more, none of which are safe to commit — **add these to your own `.env` yourself**, they are
not written for you. Every value below is local-dev-only; real deployments get theirs from AWS
Secrets Manager (CLAUDE.md rule 6).

### Generate the required secrets

```powershell
# Identity-hashing key (packages/privacy, ADR-0007) — already has a generator:
pnpm gen:identity-key
```

For everything else, this one-liner prints a fresh base64 32-byte key (PowerShell has no
`openssl`/`node -e` shorthand that survives quoting cleanly, so use a small script):

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Run it **four more times** for `CREDENTIALS_MASTER_K1`, and run this variant twice for the two hex
secrets:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Add these lines to `.env`

```ini
# packages/privacy — identity hashing (ADR-0007). No default: the API refuses to boot without it.
IDENTITY_KEY_READ=k1
IDENTITY_KEY_WRITE=k1
IDENTITY_MASTER_K1=<pnpm gen:identity-key output>

# ADR-0023 — credential envelope encryption. A DIFFERENT secret family from IDENTITY_MASTER_*.
CREDENTIALS_KEY_READ=k1
CREDENTIALS_KEY_WRITE=k1
CREDENTIALS_MASTER_K1=<base64 output>

# privacy-dpdp.md §4.10 — the DPA version tenants must accept. Any string matching [A-Za-z0-9._-]{1,32}
# works for local dev; it just has to match VITE_DPA_VERSION below.
DPA_VERSION=dev-1

# shopify-integration.md §2.1 / ADR-0024/0025 — Shopify OAuth. Real values only matter once you have
# a Shopify Partner app (M0-7); dummy strings are fine for everything except actually connecting a
# real store (Integrations screen will redirect to a real Shopify "store unavailable" page, which
# proves the OAuth flow is wired correctly — see PR #39's report for what that looks like).
SHOPIFY_CLIENT_ID=dev-client-id
SHOPIFY_CLIENT_SECRET=dev-client-secret
SHOPIFY_APP_URL=http://localhost:3000
SHOPIFY_OAUTH_STATE_SECRET=<hex output, >= 32 chars>

# auth-tenancy.md §2.2 — Better Auth. Google sign-in isn't exposed yet (issue #16), so its client
# id/secret can be any non-empty placeholder for local dev.
BETTER_AUTH_SECRET=<hex output, >= 32 chars>
BETTER_AUTH_URL=http://localhost:3000
DASHBOARD_URL=http://localhost:5173
GOOGLE_CLIENT_ID=dev-google-client-id
GOOGLE_CLIENT_SECRET=dev-google-client-secret

# Local-dev-only cookie opt-out (this PR's decision — see #39): the dashboard runs on plain http,
# and Better Auth's session cookie is Secure by default. createAuth() refuses this flag outright if
# NODE_ENV=production, so it can only ever weaken a local run.
AUTH_ALLOW_INSECURE_COOKIES=true
```

## 4. Set up the dashboard's own env

The dashboard reads two Vite env vars — put these in `apps/dashboard/.env.local` (create the file;
it's gitignored, same rule as the root `.env`):

```ini
VITE_API_URL=http://localhost:3000
# Must match DPA_VERSION above exactly — there's no endpoint to read the API's current version
# (a prior overnight run's decision, and this run's DPA screen; see decisions for review in #39).
VITE_DPA_VERSION=dev-1
```

## 5. Start the API and the dashboard

Two terminals (don't use the root `pnpm dev` — it would also try to start `apps/collector` and
`apps/workers`, which this ticket doesn't need and haven't been wired to run standalone yet):

```powershell
# Terminal 1
pnpm --filter @truepath/api dev
```

```powershell
# Terminal 2
pnpm --filter @truepath/dashboard dev
```

Open **http://localhost:5173**. You should land on `/login`.

## 6. Sign up

1. Click "Sign up", create an account. You'll see "Check your email" — **this is expected**; SES
   isn't wired yet (issue #6), so no real email is sent.
2. Verify yourself manually in Postgres (local dev only — never do this against a real deployment):

   ```powershell
   docker exec -it truepath-postgres-1 psql -U truepath -d truepath -c "UPDATE users SET email_verified = true WHERE email = '<the email you signed up with>';"
   ```

3. Log in. Since this is your first account, you'll land on "Create your organization" — after
   that you're in the real app shell (sidebar, org switcher, overview, team, integrations, audit
   log, DPA).

## What you can actually click through

- **Auth**: sign up, log in, log out — real Better Auth sessions.
- **Organization overview**: real org + store data.
- **Team & invites**: real member list, invite (role ceilings enforced both in the UI and by the
  API), role change, remove/leave.
- **Integrations**: the "Connect Shopify" button does a real OAuth redirect through the API to
  Shopify's actual `myshopify.com` authorize endpoint (it 404s there unless you enter a shop that
  really exists — that 404 is Shopify's, and it's proof the redirect chain is correct end to end).
  Disconnect works once you have a real integration.
- **Audit log**: real entries, IST-formatted, cursor-paginated, filterable by action. Viewing it is
  itself audited — you'll see `audit_log_viewed` after your first visit.
- **DPA**: accept the configured version; a version mismatch (if `VITE_DPA_VERSION` and
  `DPA_VERSION` drift) shows the server's current version.
- **Analytics / Attribution / Orders**: proper empty states ("Coming in M3-4" etc.) — no invented
  numbers, because the reporting API doesn't exist yet.

## Known limitations (not fixed in this PR)

- **No email verification loop locally** — see step 6 above (issue #6, SES).
- **A few benign console warnings** from the shadcn `base-sera` (Base UI) preset: "Function
  components cannot be given refs" on `SidebarMenuButton`/`Button` when used as a `DropdownMenuTrigger`/
  `AlertDialogTrigger`'s `render` target. Verified these don't break functionality (menus and
  dialogs open and work correctly) — it's the generated components not being wrapped in
  `React.forwardRef`. Worth a follow-up issue if it turns out to matter for keyboard/focus
  behaviour beyond what was manually tested here.
- **No route-level code splitting yet** — the JS bundle is ~207 KB gzipped, under dashboard.md's
  250 KB budget, but will need splitting once the report screens (M3-4) land.
