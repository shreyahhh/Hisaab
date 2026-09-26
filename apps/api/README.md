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
`IDENTITY_MASTER_K1=$(pnpm -s gen:identity-key)`.

Rate-limit keys (`rateLimit.ts`) and everything else that pseudonymises an identifier use the hasher
from `@truepath/privacy`; nothing here implements its own hashing.

`login_failed` audit rows record `target_user_id` (the attempted email belongs to a user) or
`unknown_account: true` — never the email, and no hash of it.

Tests run files one at a time (`vitest.config.ts`): they share one Postgres and one durable Redis
and assert on global state.

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
