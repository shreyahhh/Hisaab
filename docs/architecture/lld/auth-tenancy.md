# LLD — Auth, tenancy & RBAC

> Names are defined in [HLD §8](../HLD.md#8-cross-cutting-concepts). Tenant isolation follows **Accepted [ADR-0016](../../adr/0016-tenant-isolation-strategy.md)**. Authentication is **Accepted [ADR-0012](../../adr/0012-auth-better-auth.md): Better Auth, self-hosted on our Postgres in ap-south-1**. The ORM is **Accepted ADR-0011 (Drizzle)**; Better Auth uses its Drizzle adapter on the same schema and migrations ([Better Auth database](https://www.better-auth.com/docs/concepts/database)).

## 1. Purpose & scope

- **Authentication** of merchant staff with Better Auth: email + password (with email verification) and Google sign-in; sessions; `GET /v1/me`.
- **Organisations, stores, memberships and invites**, via Better Auth's **organization plugin**, with our roles. Agencies: one user in many orgs.
- **RBAC**: `owner | admin | analyst | viewer` (SPEC S-3) and the permission matrix every other LLD uses.
- **Tenant scoping** (ADR-0016 implementation): `TenantScope`, `SystemScope`, the scoped repository, the scoped ClickHouse builder, lint rules, the generated cross-tenant test.
- **DPA acceptance** endpoint (semantics in privacy-dpdp §4.10) and **org deletion** lifecycle.

**Non-goals**
- Shopper identity (identity-stitching).
- Billing (SPEC §2).
- White-label.
- SAML/enterprise SSO.
- Machine API keys (privacy-dpdp Q4).
- MFA enforcement (Open question 2).

## 2. Interfaces

### 2.1 Endpoints (SPEC v0.5 §10)

| Endpoint | Auth | Implementation |
|---|---|---|
| `POST /v1/auth/signup` | public | `{email, password (≥ 12), name}` → `auth.api.signUpEmail`; a verification email via SES; `requireEmailVerification: true` |
| `POST /v1/auth/login` | public | `{email, password}` → `auth.api.signInEmail`; sets the session cookie. Audit `login_succeeded` / `login_failed`; `login_failed` metadata is `{target_user_id}` when the attempted email belongs to a user, else `{unknown_account: true}` — never the email or a hash of it |
| `POST /v1/auth/logout` | session | `auth.api.signOut` |
| `/v1/auth/*` (Better Auth handler) | varies | Better Auth's own routes, mounted as a Fastify catch-all under `/v1/auth/`: `sign-in/social` (Google), `callback/google`, `verify-email`, `request-password-reset`, `reset-password`, and so on. Only the routes of enabled features are exposed. |
| `GET /v1/me` | session | `{user, memberships[{org, role}], breach_notices[]}` |
| `GET /v1/orgs`, `POST /v1/orgs` | session | organization plugin `createOrganization`; the creator becomes `owner` |
| `GET /v1/orgs/:id/stores` | member | our table `stores` (created by the Shopify connect flow) |
| `POST /v1/orgs/:id/invites` | owner, admin | `{email, role}` → plugin `createInvitation`; `sendInvitationEmail` via SES; admins can't invite owners |
| `POST /v1/invites/:token/accept` | session (the invitee) | plugin `acceptInvitation`, after two checks of ours: the logged-in email equals the invited email (`403 invite_email_mismatch`), and the **inviter still has standing** — still a member with `team.manage` and a rank ≥ the invited role (`403 invite_no_longer_valid`). Better Auth checks pending/expiry/recipient but never the inviter, so without this a pending invite outlives a demotion or removal. Rate-limited per IP (§5) |
| `PUT /v1/orgs/:id/members/:userId` | owner (admins for analyst/viewer) | `{role}` → plugin `updateMemberRole`; last-owner guard |
| `DELETE /v1/orgs/:id/members/:userId` | owner (admins for analyst/viewer), or self | plugin `removeMember`; last-owner guard |
| `POST /v1/orgs/:id/dpa/accept` | owner | `dpa_acceptances` (privacy-dpdp §4.10) |
| `DELETE /v1/orgs/:id` | **owner only** | starts org deletion (§4.6) |
| **Proposed** `POST /v1/orgs/:id/deletion/cancel` | owner | cancels within the 7-day grace period (Open question 1) |

### 2.2 Better Auth configuration (`packages/auth`)

```ts
export const auth = betterAuth({
  database: /* Drizzle or Prisma adapter per ADR-0011 */,
  basePath: '/v1/auth',
  advanced: {
    database: { generateId: 'uuid' },                      // SPEC ids are UUIDs
    ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },  // behind one ALB hop; used for rate limiting
    useSecureCookies: true,
    crossSubDomainCookies: { enabled: true, domain: '<registrable domain>' },   // app.<d> and api.<d>
    // Explicit, not left to Better Auth's own default: it silently disables this check whenever
    // NODE_ENV reads "test" (isTest(), @better-auth/core), which is exactly Vitest's default and
    // is cached at module load, so it can't be toggled per-instance — trustedOrigins matters too
    // much to depend on an env-detection heuristic (M0-4 review; betterAuth.ts).
    disableOriginCheck: false,
  },
  trustedOrigins: ['https://app.<domain>'],
  emailAndPassword: {
    enabled: true, minPasswordLength: 12, requireEmailVerification: true,
    sendResetPassword: sesSend('reset'),
  },
  emailVerification: { sendVerificationEmail: sesSend('verify') },
  socialProviders: { google: { clientId, clientSecret, scope: ['openid', 'email', 'profile'] } },
  session: { modelName: 'sessions', expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },   // 14-day sliding
  rateLimit: { enabled: true, window: 60, max: 10, storage: 'secondary-storage' },  // durable Redis, prefix ba: (ADR-0019)
  user:         { modelName: 'users' },
  account:      { modelName: 'auth_accounts' },
  verification: { modelName: 'auth_tokens' },
  databaseHooks: { session: { create: { before: truncateSessionIp } } },     // store the IP as /24 (/48 for IPv6) only
  plugins: [organization({
    schema: { organization: { modelName: 'organizations' }, member: { modelName: 'memberships' },
              invitation: { modelName: 'invites' } },
    ac, roles: { owner, admin, analyst, viewer },        // custom access control (§2.4)
    invitationExpiresIn: 60 * 60 * 24 * 7,               // 7 days (plugin default is 48 h)
    sendInvitationEmail: sesSend('invite'),
    allowUserToCreateOrganization: true,
  })],
});
```

Options are per the [Better Auth options reference](https://www.better-auth.com/docs/reference/options) and the [organization plugin](https://www.better-auth.com/docs/plugins/organization). Secrets (the Better Auth secret, Google client secret) come from Secrets Manager via env validated with zod (SPEC §0 rule 6).

### 2.3 Types (`packages/shared/auth.ts`)

```ts
export type Role = 'owner' | 'admin' | 'analyst' | 'viewer';
export type Permission =
  | 'reports.read' | 'reports.export' | 'journey.read'
  | 'settings.attribution.write' | 'settings.channel_rules.write'
  | 'integrations.manage' | 'integrations.settings.write'
  | 'privacy.requests' | 'privacy.export.download' | 'privacy.settings.write'
  | 'audit.read' | 'team.manage' | 'dpa.accept' | 'org.delete';

export type TenantScope = {
  readonly kind: 'tenant'; readonly userId: string | null;
  readonly organizationId: string; readonly role: Role | 'job';
  readonly storeIds: ReadonlySet<string>;
};
export type SystemReason =
  | 'retention' | 'order_status_reconcile' | 'suppression_rebuild' | 'attribution_nightly'
  | 'shopify_reconcile' | 'key_rotation' | 'breach_admin' | 'scheduler_fanout' | 'org_deletion';
export type SystemScope = { readonly kind: 'system'; readonly reason: SystemReason; readonly auditId: string };
export function can(scope: TenantScope, p: Permission): boolean;
```

### 2.4 Permission matrix

This is also encoded as Better Auth access-control statements (`createAccessControl`) for the plugin's own `organization` / `member` / `invitation` actions.

| Permission | owner | admin | analyst | viewer |
|---|:-:|:-:|:-:|:-:|
| `reports.read` | ✓ | ✓ | ✓ | ✓ |
| `reports.export` (CSV, audited) | ✓ | ✓ | ✓ | |
| `journey.read` (personal-data view, audited) | ✓ | ✓ | ✓ | |
| `settings.attribution.write`, `settings.channel_rules.write` | ✓ | ✓ | | |
| `integrations.manage`, `integrations.settings.write` (incl. CAPI Purchase opt-in) | ✓ | ✓ | | |
| `privacy.requests`, `privacy.export.download`, `privacy.settings.write` | ✓ | ✓ | | |
| `audit.read` | ✓ | ✓ | | |
| `team.manage` | ✓ | ✓ (not owners) | | |
| `dpa.accept`, `org.delete` | ✓ | | | |

Every org keeps ≥ 1 owner; demoting or removing the last owner → `409 last_owner`. Better Auth's default `member` role is replaced by `analyst` and `viewer`.

## 3. Data owned

Better Auth models map onto SPEC table names (`modelName`); the schema is generated with the Better Auth CLI into `packages/db` migrations. Folded into **SPEC v0.5 §6.1** (approved via ADR-0012):

| SPEC table | Better Auth model | Columns (Better Auth fields + ours) | Change vs SPEC v0.4 |
|---|---|---|---|
| `users` | `user` | `id`, `email`, `name`, `email_verified`, `image`, `created_at`, `updated_at` | `password_hash` and `sso_provider` **move to `auth_accounts`** |
| `auth_accounts` | `account` | `id`, `user_id`, `provider_id` (`credential` \| `google`), `account_id`, `password` (hash, credential provider), `access_token`/`refresh_token`/`id_token` (Google), token expiries, `scope`, timestamps | **new** |
| `sessions` | `session` | `id`, `token`, `user_id`, `expires_at`, `ip_address` (truncated by hook), `user_agent`, `active_organization_id`, timestamps | **new** |
| `auth_tokens` | `verification` | `id`, `identifier`, `value`, `expires_at`, timestamps | **new** (email verification, password reset) |
| `organizations` | `organization` | `id`, `name`, `slug`, `logo`, `metadata` jsonb, `created_at` + ours: `plan`, `status` (`active`\|`pending_deletion`\|`deleted`) | fields added by the plugin |
| `memberships` | `member` | `id`, `organization_id`, `user_id`, `role`, `created_at` | adds `id`, `created_at` |
| `invites` | `invitation` | `id`, `organization_id`, `email`, `role`, `status`, `expires_at`, `inviter_id` | **new** |

Notes:
- Google OAuth tokens in `auth_accounts` are not needed after sign-in (we request only `openid email profile`). An `account.create.after` database hook nulls `access_token`, `refresh_token` and `id_token` to minimise stored secrets; this is an implementation check against the Better Auth version used.
- Password hashing uses Better Auth's built-in hasher; no custom hashing code.
- **Better Auth is the one allowed exception** to "all Postgres access goes through our scoped repository" (ADR-0016). It reads and writes only the seven tables above, which are global or org-keyed identity tables, not store data. The lint allowlist permits the ORM import in `packages/auth` for this.
- `dpa_acceptances` (write, via endpoint) and `audit_log` (write) as before.
- Redis (cache instance) key prefix **`ba:`** for Better Auth rate-limit counters (HLD §8, SPEC v0.5).

## 4. Processing flow

### 4.1 Sessions
- Better Auth session cookie: `Secure`, `HttpOnly`, `SameSite=Lax`, shared across `app.<d>` and `api.<d>` (`crossSubDomainCookies`). `Secure` is the **default** (`createAuth`'s `allowInsecureCookies` is an explicit local-dev opt-out, and throws under `NODE_ENV=production`), so forgetting production wiring fails closed.
- 14-day sliding expiry, refreshed daily.
- `trustedOrigins` limits the origins allowed to call auth routes. Our own state-changing routes also require `Content-Type: application/json` and an `Origin` equal to the dashboard origin (CSRF).
- Password change and reset revoke other sessions (Better Auth `revokeOtherSessions` on change). Logout deletes the session row.
- The session's `active_organization_id` is **not used for authorisation**. Every request authorises against the route's org/store and the membership table (§4.3).

### 4.2 Signup, verification, invites
1. Signup → the user row plus an `auth_accounts` credential row. SES sends the verification link (Better Auth route `verify-email`). No session until verified.
2. Google sign-in → an `auth_accounts` google row (tokens nulled by the hook); email verified by Google.
3. Invite → `createInvitation` (7-day expiry) → SES email with `https://app.<d>/invite/<id>` → the invitee logs in or signs up → `POST /v1/invites/:token/accept` → `acceptInvitation` → membership. Audit `member_invited` / `member_invite_accepted`.
4. Invite rows are deleted 30 days after acceptance or expiry by the nightly `retention` job (minimisation of staff emails).

### 4.3 Request → `TenantScope`
1. `auth.api.getSession({ headers })` → user, or `401`.
2. Route params:
   - `:orgId` → membership `(userId, orgId)`; none → **`404`** (don't reveal other tenants, §5.10 test 7);
   - `:storeId` → join `stores → memberships`; none → `404`.
3. Build `TenantScope {organizationId, role, storeIds}` once per request.
4. The route's declared permission is checked with `can(scope, p)` → **`403 forbidden_role`**.
5. Handlers pass `request.scope` to repositories only.

### 4.4 Scoped data-access layer (ADR-0016)
- **Postgres**: `packages/db` exports repositories only. Each method asserts that the store is in scope (or that the scope is a system scope), and each query carries a `store_id` / `organization_id` predicate. The only other DB user is `packages/auth` (Better Auth, §3).
- **ClickHouse**: `ch(scope, storeId)` injects a parameterised `store_id = {store_id:UUID}` into every statement; there is no raw-SQL API.
- **Lint** (CI-blocking): importing `pg`, the ORM client or `@clickhouse/client` is forbidden outside `packages/db`, `packages/clickhouse` and `packages/auth`. Template-string SQL is forbidden outside those packages.
- **Keys and paths**: `reportCacheKey`, `dsrExportKey`, `dedupeKey`, `suppressionKey` helpers are the only way to build tenant keys and paths. A unit test greps for literal prefixes outside the helpers.
- **Jobs**: every payload carries `storeId`; `TenantScope.forJob(storeId)` after an existence check.
- **`SystemScope.create(reason)`**: writes `system_scope_used` and is the only unscoped path (retention, reconcile fan-outs, suppression rebuild, key rotation, breach CLI, org deletion).

```mermaid
sequenceDiagram
  participant C as Dashboard
  participant F as Fastify preHandlers
  participant BA as Better Auth (packages/auth)
  participant PG as Postgres
  participant H as Handler
  participant R as Repository / CH builder
  C->>F: GET /v1/stores/S/reports/overview (session cookie)
  F->>BA: getSession(headers) → user or 401
  F->>PG: membership for (user, store S) → none ⇒ 404
  F->>F: TenantScope; can(scope, 'reports.read') → else 403
  F->>H: request.scope
  H->>R: repo(scope, S) / ch(scope, S)
  R->>R: assert S ∈ scope.storeIds; inject store_id param
```

### 4.5 DPA gating
`POST /v1/orgs/:id/dpa/accept` (owner):
- `dpa_version` must equal `DPA_VERSION`, else `409`;
- insert `dpa_acceptances` with `ip_truncated` (/24 or /48);
- audit;
- republish collector configs (privacy-dpdp §4.10).

### 4.6 Org deletion (approved lifecycle)
1. **Export first.** The dashboard offers downloads (aggregate report CSVs, plus DSR exports still within their 30-day window) before the confirm step (dashboard §4.7).
2. `DELETE /v1/orgs/:id` (**owner only**, org name typed as confirmation):
   - `organizations.status='pending_deletion'`, `metadata.deletion_scheduled_at = now + 7 days`, `metadata.deletion_due_by = now + 30 days`;
   - every store's collector config becomes `inactive` (no new data);
   - repeatable sync jobs paused;
   - all members see a banner;
   - audit `org_deletion_requested`.
3. **Grace period (7 days)**: the owner can cancel (Open question 1) → `status='active'`, configs republished, audit `org_deletion_cancelled`.
4. **After the grace period**: a scheduler under `SystemScope('org_deletion')` runs:
   - `store_erasure` for each store (privacy-dpdp §4.7);
   - token revocation and deletion for every integration;
   - deletion of `memberships` and `invites`;
   - deletion of users with no other memberships, together with their sessions, accounts and auth tokens.
5. **Completion ≤ 30 days** from the request (SPEC §5.7):
   - `organizations` is kept as a tombstone (`status='deleted'`, name replaced by `deleted-<id>`, metadata cleared);
   - `audit_log` is kept ≥ 1 year (S-4);
   - audit `org_deleted` with per-store counts.
   - A daily check alerts if any `pending_deletion` org passes `deletion_due_by`.
6. The Shopify app must be uninstalled by the merchant (we can't); the confirmation screen says so. `app/uninstalled` and `shop/redact` then arrive and are idempotent against already-erased stores.

## 5. Failure modes

| Failure | Behaviour |
|---|---|
| Brute-force login | Better Auth rate limit (10 per 60 s per IP on its own `/v1/auth/*` routes, counters in durable Redis `ba:` — ADR-0019) → `429`. **Our own** `POST /v1/auth/signup|login` and `POST /v1/invites/:token/accept` call `auth.api.*`, which skips that limiter, so `apps/api` limits them itself (`@fastify/rate-limit`, durable Redis `rl:`): 10 per 60 s per IP, plus login **5 per 60 s per email** (case-insensitive) so a run spread over many IPs is still capped. Keys hold an HMAC of the IP/email, never the raw value; a Redis outage errors the request rather than skipping the limit. Audit `login_failed` (interim: no identifier at all until M0-5's HMAC helper) |
| Durable Redis down | Better Auth rate limiting falls back as configured (**fail closed** on auth routes: `503`), so logins pause rather than going unthrottled — the same outage HLD Q2/Q14 already treat as collector- and worker-wide, so auth failing closed too is consistent, not a new failure mode |
| Session lookup failure (Postgres) | `503`; never treated as unauthenticated-but-allowed |
| Membership removed mid-session | the next request → `404` for that org |
| Invite for an email different from the logged-in user | `403 invite_email_mismatch` |
| Missing scope in code | type error (repositories require a scope) plus a runtime assert |
| Cross-tenant id in path or body | `404` via the scope check; body ids re-validated through repositories |
| Org deletion overdue | alert; manual intervention; audit trail shows progress |

## 6. Privacy touchpoints

| ID | How |
|---|---|
| S-3 | RBAC matrix (our `can()` plus Better Auth access control for org actions); ADR-0016 scoped layer; `404` for other tenants. |
| S-4 | Login outcomes, team changes, DPA, system scope, org deletion events and all permissioned writes audited. |
| S-1 / S-2 / S-6 | Secure cookies over TLS; Better Auth and Google secrets in Secrets Manager; OAuth tokens nulled after Google sign-in. |
| §5.1 / §5.9 | Staff data (we are the Fiduciary) lives in our Postgres in ap-south-1. There is no auth sub-processor (Clerk rejected in ADR-0012 as a US sub-processor). Session IPs are truncated; invites purged after 30 days. |
| §5.7 | Org deletion completes within 30 days, export offered first. |
| Logs | No passwords, tokens, cookies or emails in logs. |

## 7. Performance & limits

| Item | Target |
|---|---|
| Session + scope build | < 10 ms p95 (session lookup by token plus one membership query) |
| Rate limit | 10 requests / 60 s per IP on `/v1/auth/*` sign-in, sign-up and reset routes |
| Session | 14-day sliding, daily refresh |
| Invite | 7-day expiry |
| Org deletion | 7-day grace; complete ≤ 30 days |

## 8. Test plan

**Unit**
- `can()` against the full matrix.
- Last-owner guard.
- Invite email mismatch.
- The session-IP truncation hook.
- The Google-token nulling hook.
- The CSRF Origin check.

**Integration — generated cross-tenant matrix (§5.10 test 7)**
- Enumerate every registered Fastify route with `:id`/`:orgId`/`:storeId`/`:rid`/`:orderId`/`:userId`.
- Seed orgs A and B with data in every table.
- Call each route as A's owner with B's ids → expect `404`, with no B data in the body or the logs.
- New routes are covered automatically; opting out needs an allowlist entry.

**Integration — Better Auth**
- Signup → no session before verification.
- Google sign-in creates an account row with nulled tokens.
- Invite → accept → membership with the right role.
- Custom roles are enforced for org actions.
- Rate limit → `429`.

**Integration — org deletion**
- `DELETE` → configs inactive, banner shown.
- Cancel within 7 days → restored.
- After 7 days → stores erased, users without other orgs deleted, audit kept, tombstone left.
- The overdue alert fires in a time-travel test.

**Lint**: an ORM import in `apps/api` outside allowed packages fails CI.

**§5.10 compliance tests supported**: test 7 (primary owner) and test 8 (audit on settings, team and org deletion).

## 9. Open questions
1. **Cancelling org deletion** needs an endpoint (`POST /v1/orgs/:id/deletion/cancel`, proposed; not in SPEC v0.5). Alternative: cancellation via support only.
2. **MFA**: Better Auth has a two-factor plugin. Make TOTP required for owners and admins before GA (they can download DSR exports)? Proposed: optional in MVP, required before GA.
3. **Staff DSRs** (we are the Fiduciary for staff data): self-service "delete my account" (Better Auth supports user deletion) vs support-handled for MVP. Proposed: support-handled with an audit entry.
4. **Breached-password check** (k-anonymity API) — a new external call; defer.
