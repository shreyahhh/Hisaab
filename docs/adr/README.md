# Architecture Decision Records

Michael Nygard format (Title, Status, Context, Decision, Consequences). **Accepted** ADRs are binding: code must not contradict them. To change one, write a new ADR that supersedes it (SPEC §0 rule 9, root `CLAUDE.md`). **Proposed** ADRs list options and a recommendation, and wait for a decision.

| # | Title | Status | Source |
|---|---|---|---|
| [0001](0001-fastify-for-api-and-collector.md) | Fastify for Core API and Collector | Accepted | SPEC §3 |
| [0002](0002-bullmq-and-redis-streams-for-async-work.md) | BullMQ for jobs, a Redis Stream for ingestion, two Redis instances | Accepted | SPEC §3 + HLD review |
| [0003](0003-clickhouse-for-event-analytics.md) | ClickHouse for events and analytics | Accepted | SPEC §3 |
| [0004](0004-postgresql-for-oltp.md) | PostgreSQL 16 for OLTP state | Accepted | SPEC §3 |
| [0005](0005-aws-mumbai-hosting-for-data-residency.md) | Host in AWS ap-south-1 for data residency | Accepted | SPEC §3, §5.9 |
| [0006](0006-money-as-integer-paise.md) | Money as integer paise | Accepted | SPEC §6.1, §13 |
| [0007](0007-pii-hashing-strategy.md) | PII hashing strategy (tenant HMAC with key versions, send-time SHA-256) | Accepted | SPEC §5.4 |
| [0008](0008-shopify-web-pixel-for-tracking.md) | Shopify Web Pixel extension for first-party tracking | Accepted | SPEC §7.1 |
| [0009](0009-pnpm-turborepo-monorepo.md) | pnpm workspaces + Turborepo monorepo | Accepted | SPEC §3–4 |
| [0010](0010-react-vite-dashboard-stack.md) | React + Vite dashboard stack (TanStack Router) | Accepted | SPEC §3, v0.5 |
| [0011](0011-orm-prisma-vs-drizzle.md) | ORM: Prisma vs Drizzle | Accepted (Drizzle) | SPEC §15.1 |
| [0012](0012-auth-better-auth.md) | Authentication: Better Auth, self-hosted | Accepted | SPEC §15.2 |
| [0013](0013-clickhouse-self-managed-vs-cloud.md) | ClickHouse hosting: self-managed vs Cloud | Accepted, conditional on staging test (Cloud ap-south-1) | SPEC §15.3 |
| [0014](0014-pixel-collector-domain-strategy.md) | Pixel → Collector domain | Accepted (our domain) | SPEC §15.4 |
| [0015](0015-clickhouse-deletion-strategy.md) | ClickHouse deletion strategy | Accepted | SPEC §15.5 |
| [0016](0016-tenant-isolation-strategy.md) | Tenant isolation strategy | Accepted | HLD review (not in SPEC §15) |
| [0017](0017-event-dedup-strategy.md) | Event de-duplication for `events` / `touchpoints` | Accepted | HLD review |
| [0018](0018-vitest-for-testing.md) | Vitest as the unit test runner | Accepted | SPEC §15 (open decision, M0-1) |
| [0019](0019-better-auth-rate-limit-storage-durable-redis.md) | Better Auth rate-limit storage: durable Redis, not cache Redis | Accepted, supersedes ADR-0012's placement | M0-4 review |
| [0020](0020-identity-master-keys-via-env.md) | Identity master keys injected as env vars from Secrets Manager | Accepted, refines ADR-0007 | M0-5 review |
| [0021](0021-audit-writes-after-better-auth-commits.md) | Audit writes for Better Auth actions: after the commit, retried once, reported on failure | Accepted | M0-6 review |
| [0022](0022-better-auth-http-allow-list.md) | Better Auth's HTTP routes are an allow-list; a route joins only in the change that audits it | Accepted | M0-6 review |
| [0023](0023-integration-credential-envelope-encryption.md) | Integration credentials: env-injected master key + local AES-256-GCM, not live KMS calls | Accepted, extends ADR-0020 | M1-1 review |
| [0024](0024-shopify-integration-routes-nested-under-orgs.md) | Shopify connect/disconnect nested under `/v1/orgs/:id/integrations` | Accepted, narrows SPEC §10 | M1-1 review |
| [0025](0025-shopify-oauth-state-token.md) | Shopify OAuth `state`: HMAC-signed token + single-use Redis nonce | Accepted | M1-1 review |
| [0026](0026-event-workers-per-store-scope.md) | Event workers act under a one-store TenantScope, not a SystemScope (per-store ClickHouse inserts) | Accepted, refines ADR-0016 | M1-6 review |
| [0027](0027-meta-warmup-token-registration.md) | Meta warm-up slice: token registration via an operator CLI, not OAuth | Accepted | M1-8 planning |

**Decisions made during the review that are recorded in HLD §8 / SPEC v0.5 rather than as separate ADRs** (candidates to promote if they are ever revisited):
- query-time delivered revenue via `order_status`;
- the suppression set and fail-closed behaviour;
- withdrawal-triggered erasure;
- CAPI Purchase opt-in and `system_generated` DeliveredPurchase/RTO;
- the neutral logistics webhook path.
