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
