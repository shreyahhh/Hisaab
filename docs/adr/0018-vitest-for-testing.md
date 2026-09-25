# 0018. Vitest as the unit test runner

## Status
Accepted

## Context
SPEC §3 fixes most of the stack but doesn't name a unit test runner; SPEC §14 only fixes fast-check
(property-based tests) and Playwright (E2E) on top of whatever runner is chosen. CLAUDE.md rule 9
requires an ADR before picking one. The monorepo (ADR-0009) is pnpm workspaces + Turborepo, strict
TS everywhere (CLAUDE.md rule 4), and every module ships unit tests (CLAUDE.md rule 5), so the
runner needs to work cleanly per-package with minimal config.

## Options considered
1. **Vitest** — ESM-native, uses esbuild so no separate TS transform config, fast, first-class
   Vite integration for `apps/dashboard` (ADR-0010), minimal per-package config, integrates
   directly with fast-check for property-based tests (SPEC §14).
2. **Jest** — larger ecosystem and more prior art, but needs `ts-jest` or Babel to handle strict
   TS + ESM in a pnpm workspace, and is slower; the dashboard would end up running two different
   test runners (Jest for units, something Vite-native for anything component-level) unless
   configured carefully.

## Decision
**Vitest**, run through Turborepo's `test` task, invoked per-package with no shared runtime
config beyond `devDependencies` hoisted at the workspace root.

## Consequences
- One test runner across `apps/*` and `packages/*`, including `apps/dashboard`.
- `fast-check` (attribution property tests, SPEC §9) and `@testing-library/react` (when the
  dashboard needs component tests) are added as needed in their milestones, not in M0-1.
- Testcontainers-based integration tests (SPEC "pnpm test" description) also run under Vitest;
  wired up when the first package needs a real Postgres/ClickHouse/Redis in CI (M0-3+).
