# apps/api — Core API

Fastify service for auth, tenants, integrations, reports and DPDP endpoints, plus the Shopify and
Shiprocket webhook receivers (SPEC §10, §4; `docs/architecture/lld/auth-tenancy.md`,
`reporting-api.md`, `privacy-dpdp.md`).

Empty scaffold as of M0-1. Env validation at boot (Postgres, ClickHouse, both Redis, `API_PORT`)
lands in M0-2 (`packages/shared/src/env.ts`). The Fastify server, zod request validation and the
tenant-scoping middleware land starting M0-4.

## Configuration

Boot validates the environment with zod (`apiEnvSchema` in `src/index.ts`). Beyond Postgres,
ClickHouse, the two Redis instances and `API_PORT`, it **requires** the identity hash keys —
`IDENTITY_KEY_READ`, `IDENTITY_KEY_WRITE` and one `IDENTITY_MASTER_K<N>` per readable version — with no
default, in any environment. See `packages/privacy/README.md` and ADR-0020; locally,
`IDENTITY_MASTER_K1=$(pnpm -s gen:identity-key)`. It also requires `DPA_VERSION` (no default; locally
`DPA_VERSION=0.1-draft`, the draft in `docs/dpdp/dpa-template.md`).

Rate-limit keys (`rateLimit.ts`) and everything else that pseudonymises an identifier use the hasher
from `@truepath/privacy`; nothing here implements its own hashing.

`login_failed` audit rows record `target_user_id` (the attempted email belongs to a user) or
`unknown_account: true` — never the email, and no hash of it.

Tests run files one at a time (`vitest.config.ts`): they share one Postgres and one durable Redis
and assert on global state. `turbo.json` also runs a package's tests after its dependencies' (`test` depends on `^test`), so the db, auth and api suites take turns on the one Postgres instead of racing.

## Calling Better Auth: `authCall`

Better Auth reports failure two ways: `auth.api.*` throws an `APIError`, or, with `asResponse: true`,
it **returns** a 4xx `Response` without throwing. Treating "no exception" as success audited every
wrong password as `login_succeeded`. Every `auth.api.*` call goes through `authCall`
(`src/authCall.ts`), which turns both forms into one thrown `AuthApiError` (status + Better Auth's
error code). `app.ts` maps an uncaught one to that status with `{ "error": "<code>" }`; a handler
that needs to act on a failure (login's audit row, the members routes' `last_owner`) catches it
and rethrows. Anything else that is thrown (a database outage, a bug) is not converted and stays a 500.
`src/authCall.test.ts` fails if any `auth.api.*` call in the app is not wrapped, and
`src/authFailurePaths.test.ts` covers each call site's failure (HTTP response and audit rows).

Failed sign-up, login and logout now answer `{ "error": "<code>" }` like every other route, instead of
forwarding Better Auth's own `{ "code", "message" }` body.

## Audit log (M0-6)

Every audited action goes through `deps.audit` (`src/audit.ts`), never straight to the table.

- **After a Better Auth commit** (`member_invited`, `member_invite_accepted`, `member_role_changed`,
  `member_removed`, `login_succeeded`, `login_failed`): `afterCommit` / `afterCommitPlatform` write the
  row, retry once, and on a second failure return the real response anyway and report an
  `audit_write_failed` line (with the full intended entry) for the alert. Better Auth's organization
  hooks don't run inside a transaction, so atomic rows aren't possible; see ADR-0021.
- **Our own reads** (`audit_log_viewed`): written before the response; if it fails, so does the request.
- `GET /v1/orgs/:id/audit-log` takes `from`, `to`, `action` (must be in the catalogue), `limit`
  (1–200, default 50) and an opaque `cursor`, and returns `{ items, next_cursor }` newest first. A bad
  parameter is `400 invalid_query` with the offending names; another organization's id is a 404 before
  any validation. Only the first page is audited.
- `AUDIT_ACTION_OWNERS` (`packages/shared`) names the ticket that emits each catalogue action, and
  `src/auditCoverage.test.ts` fails when an emitter or its evidence test goes missing (SPEC §5.10 test 8).

## Better Auth's HTTP routes are an allow-list (ADR-0022)

Only `GET /v1/auth/get-session`, `/ok` and `/error` reach Better Auth. Everything else it ships
(52 paths in all) is a `404` twice over: Fastify registers only the allow-list
(`EXPOSED_AUTH_ROUTES` in `packages/auth/src/exposure.ts`, no wildcard), and Better Auth's own
`disabledPaths` (`DISABLED_AUTH_PATHS`) refuses the rest; organization deletion is disabled in
Better Auth. Our `/v1/auth/signup|login|logout` and `/v1/orgs/...` routes call `auth.api.*` directly
and are unaffected. **A route joins the allow-list only in the same change that audits it.**
`src/authBridge.test.ts` enumerates every path Better Auth has and fails when a new one is neither
exposed nor disabled, so an upgrade or a new plugin can't add a route silently. To expose a route:
audit it (catalogue action, schema, migration, `AUDIT_ACTION_OWNERS`), add it to
`EXPOSED_AUTH_ROUTES` with its reason, and take it out of `DISABLED_AUTH_PATHS`.

The CSRF hook (`app.ts`) covers the `/v1/auth` wrappers too: they skip Better Auth's own origin check,
so before this change a POST to login, signup or logout from another origin was processed.

Every state-changing request (anything but GET, HEAD and OPTIONS) needs exactly the dashboard's
`Origin`, or it is a 403 `invalid_origin`, a missing header included; we have no non-browser clients.
POST, PUT and PATCH also need `Content-Type: application/json` (judged first). `app.test.ts` covers the
methods, routes (unknown ones too) and Origin variants.

## DPA acceptance (`POST /v1/orgs/:id/dpa/accept`)

Owner only (`dpa.accept`). The body is exactly `{ "dpa_version": "<string>" }` and must equal the
`DPA_VERSION` this deployment requires (env, validated at boot with no default, so a draft DPA can't
reach production silently; the texts are in `docs/dpdp/`). Anything else is `409 dpa_version_mismatch`
with `current_version`, so an old or unknown text can't satisfy the tracking gate.

- `201 { id, dpa_version, accepted_at }` on the first acceptance; `200` with the same record on a
  repeat. One row per organization per version (unique index), so repeats and races write neither a
  second row nor a second audit entry.
- The `dpa_acceptances` row and its `dpa_accepted` audit row commit in **one transaction**; if either
  fails, neither exists and the caller gets a 500 (not the after-commit pattern of ADR-0021, which is only
  for Better Auth actions). Audit metadata is `{ dpa_version }` only.
- The accepting IP is stored as /24 (IPv4) or /48 (IPv6), never in full. Behind the ALB this needs
  Fastify's `trustProxy` set correctly (#3), or every request reports the ALB's address.
- `400 invalid_body` (with field names), `403 forbidden_role`, `404` for another organization (decided
  before the body is read), `401` without a session; the usual CSRF checks apply.
- **Not yet:** publishing the Collector store configs so tracking switches on (privacy-dpdp.md §4.10).
  There is no Collector yet (M1-5). It reads `createDpaAcceptanceRepository(...).findForVersion(...)`.

## Global error handler (`errors.ts`, issue #20)

Every route's *known* failures reply directly (`reply.code(...).send(...)`) and never throw. What
reaches `setErrorHandler` is only what nobody anticipated — plus two things thrown on purpose:

- an uncaught `AuthApiError` → `{ error: <code> }` with Better Auth's status (unchanged);
- a hand-built response object thrown by our own trusted code (`@fastify/rate-limit`'s
  `errorResponseBuilder`, `rateLimitedBody()` in `rateLimit.ts`) → sent back exactly as built, since
  nothing but ids/enums/counts ever goes into one (unchanged, still 429 with its own body);
- a genuine Fastify-internal **client** error — malformed JSON, a body over the size limit, an
  unsupported content type, a schema-validation failure — identified by its `FST_ERR_*` code and a
  real `statusCode` in 400-499 → the same status, but a generic code (`bad_request`,
  `payload_too_large`, `unsupported_media_type`, ...), never Fastify's own message (which can echo a
  fragment of the request, e.g. a JSON parse error's position). Not logged: these are ordinary client
  mistakes, not something to alert on. A Fastify-internal error with `statusCode >= 500` (a plugin
  bug) is not treated as a client mistake and falls through to the generic path below instead.

Anything else — a database driver error, a bug, a Fastify-internal *server* failure — used to fall through to
Fastify's default handler, which put the raw `error.message` in the 500 body; for a Drizzle/pg
failure that is the full SQL statement and its bound parameters. Now it is always a bare
`{ "error": "internal_error", "request_id": "<uuid>" }`, and the real detail is logged server-side
(one structured stderr line, `event: 'unhandled_error'`) under the same `request_id`, run through
`redactLogValue` (`@truepath/privacy`) so an identifier in a query string or an error message is
masked there too — the request URL is decoded first, since redaction's patterns match literal
characters and a raw `request.url` is percent-encoded. `redactLogValue` also now follows an `Error`'s
`.cause` chain, because a driver's own message is often just a wrapper ("Failed query: ...") with the
real detail one level down.

`request_id` comes from Fastify's own `request.id` and is generated **server-side only**: `app.ts`
sets `genReqId: () => randomUUID()`, a function that takes no argument, so it cannot read any
header — a client-sent `X-Request-Id` (or Fastify's own default `request-id` header) is always
ignored, never echoed back. It replaces Fastify's default per-process counter for the same reason
the response carries it at all: it must stay unique across restarts and across a real deployment's
several API instances, not just within one process.

Overridable in tests via `AppDeps.errorReporter`, the same DI pattern as `AuditService`'s `report`
option.
