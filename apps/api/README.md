# apps/api — Core API

Fastify service for auth, tenants, integrations, reports and DPDP endpoints, plus the Shopify and
Shiprocket webhook receivers (SPEC §10, §4; `docs/architecture/lld/auth-tenancy.md`,
`reporting-api.md`, `privacy-dpdp.md`).

Empty scaffold as of M0-1. Env validation at boot (Postgres, ClickHouse, both Redis, `API_PORT`)
lands in M0-2 (`packages/shared/src/env.ts`). The Fastify server, zod request validation and the
tenant-scoping middleware land starting M0-4.
