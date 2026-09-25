# 0001. Fastify for Core API and Collector

## Status
Accepted (fixed in SPEC §3)

## Context
Two HTTP services are needed:
- the **Core API**: auth, tenants, reports, DPDP endpoints, webhooks;
- the **Collector** (`POST /v1/collect`): stateless, high-throughput, p95 < 50 ms (SPEC §7.2), 500 events/s sustained (M4-6).

Both are TypeScript strict (SPEC §0 rule 4), validate with zod, and should produce an OpenAPI description.

## Decision
Use **Fastify** on Node 20+ for both, deployed as **separate services** (HLD §5/§7) on separate ALBs, so the Collector scales and fails independently and its access logs can be disabled (privacy-dpdp §4.11). Supporting pieces:
- zod schemas from `packages/shared` for request/response validation, exported to OpenAPI via `@fastify/swagger`;
- Fastify's pino logger with the shared redaction hook (privacy-dpdp §6);
- `preHandler` hooks for authentication and `TenantScope` building (auth-tenancy §4.3).

## Consequences
- Low per-request overhead suits the Collector's latency budget; its hot path is one Lua call to Redis (collector §4).
- One framework, one set of plugins, one logging and redaction configuration across both services.
- Raw-body parsing for HMAC-verified webhooks (Shopify) needs route-scoped content parsers (shopify-integration §4.2).
- Better Auth is mounted inside Core API under `/v1/auth/*` (ADR-0012).
