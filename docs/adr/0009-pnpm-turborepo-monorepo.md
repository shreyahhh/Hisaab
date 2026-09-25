# 0009. pnpm workspaces + Turborepo monorepo

## Status
Accepted (fixed in SPEC §3, §4)

## Context
Five apps (api, collector, workers, dashboard, shopify-app) share types, zod schemas, the privacy primitives, the scoped data layers and integration adapters. Types and schemas must not drift between services (SPEC §0 rule 5).

## Decision
A single repo with **pnpm workspaces** and **Turborepo** task orchestration, laid out as in SPEC §4:
- `apps/*`;
- `packages/{shared, db, clickhouse, integrations, attribution, privacy}`;
- plus `packages/auth` (Better Auth config, ADR-0012).

Cross-package imports use workspace protocols. Lint boundaries (ADR-0016) restrict which packages may import DB clients.

## Consequences
- One PR can change a schema and every consumer together; CI caches per package.
- Placeholder scripts `pnpm dev | test | lint | db:migrate` are run through Turborepo (root `CLAUDE.md`).
- Package boundaries carry security meaning (for example, only `packages/db`, `packages/clickhouse` and `packages/auth` may import database clients), so boundary lint is CI-blocking.
