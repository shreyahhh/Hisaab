# TruePath (working name)

India-first, DPDP-compliant multi-touch attribution for Shopify D2C brands: **delivered ROAS** per campaign/ad set/ad (RTO excluded), plus better conversion signals back to Meta.

@docs/SPEC.md
@docs/architecture/HLD.md

## Working rules (SPEC §0 — always)
1. Work milestone by milestone (SPEC §12). Don't start a later milestone unless asked.
2. Before coding a ticket: restate it, list the files you will create or change, and flag any ambiguity or conflict with the spec.
3. **Privacy is a hard requirement.** If a change would store raw PII, process data without a consent check, skip a suppression check, or skip audit logging — **stop and flag it**. Rules: SPEC §5, HLD §8 "Privacy / DPDP", `docs/architecture/lld/privacy-dpdp.md`.
4. TypeScript strict everywhere. No `any` without a comment explaining why.
5. Every module ships with unit tests, a short README section, and typed interfaces/zod schemas in `packages/shared`.
6. Never hardcode secrets. Env vars are validated with zod at boot; secrets come from AWS Secrets Manager.
7. Prefer boring, documented libraries. Ask before adding any dependency not listed in SPEC §3.
8. External APIs (Shopify, Meta, Google Ads, Shiprocket) change. Check the current versions and fields against official docs, and keep each behind its adapter in `packages/integrations/<provider>`. Version strings are single constants.
9. If a decision isn't covered: propose 2 options with trade-offs, let the human choose, and record it as an ADR in `docs/adr/`.

## Before working on a module
Read its LLD first: `docs/architecture/lld/<module>.md`. The modules are:
- collector, event-pipeline, identity-stitching, attribution-engine;
- shopify-integration, meta-integration, google-ads-integration, shiprocket-integration;
- reporting-api, privacy-dpdp, auth-tenancy, dashboard.

LLDs define interfaces, data owned, failure modes and tests. Follow them; if reality disagrees, raise it rather than drifting.

## Non-negotiables
- **Never contradict an Accepted ADR** (`docs/adr/README.md`). Propose a new ADR that supersedes it instead.
- **Names are canonical**: queues, stream, Redis keys, tables, job payloads and endpoints exactly as in **HLD §8** / SPEC §10. Don't invent new ones; add them to HLD §8's pending table and ask.
- **Tenant isolation (ADR-0016)**:
  - Postgres only through `packages/db` repositories, which take a `TenantScope`;
  - ClickHouse only through the `packages/clickhouse` query builder (no raw SQL);
  - cross-tenant work only via an audited `SystemScope`;
  - other tenants' resources return `404`.
- **Identifiers**: no raw phone/email/IP/UA anywhere at rest or in logs. Hash with `packages/privacy` (`k<N>:` HMAC); SHA-256 for Meta only in memory at send time.
- **Consent and suppression** are checked at ingest *and* again by every worker at execution time.
- **Money** is integer paise. **Time** is UTC in Postgres, IST in the UI.
- **Webhooks**: verify, dedupe, never persist or log raw payloads.

## Commands (placeholders until M0-1)
```sh
pnpm install
pnpm dev          # run api, collector, workers, dashboard locally (Docker Compose: Postgres, ClickHouse, Redis ×2)
pnpm test         # unit + integration (testcontainers); includes the SPEC §5.10 compliance suite
pnpm lint         # eslint (incl. data-access boundary rules) + typecheck
pnpm db:migrate   # Postgres migrations (packages/db) + ClickHouse migrations (packages/clickhouse)
```

## Where things are
- Spec and changelog: `docs/SPEC.md`.
- Architecture: `docs/architecture/HLD.md` (§8 is the name registry and the pending-approval list).
- Decisions: `docs/adr/`.
- Privacy docs for counsel: `docs/dpdp/` (README, sub-processors).
