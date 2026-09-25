# 0016. Tenant isolation strategy

## Status
Accepted

## Context
TruePath is multi-tenant: competing D2C brands' order, spend, and attribution data share the same Postgres and ClickHouse instances. SPEC §5.5 (S-3) requires tenant isolation but leaves the mechanism open — "Postgres RLS or mandatory `tenant_id` scoping in the repository layer + tests". This is not one of SPEC §15's open decisions, but HLD §4/§8 need a concrete answer before M0-4 (RBAC middleware, tenant scoping) starts. §5.10 test 7 (cross-tenant access → 403/404) is the acceptance bar regardless of mechanism.

About half of tenant data (`events`, `touchpoints`, `identity_links`, `ad_spend_daily`, `attribution_results`, `order_status`) lives in ClickHouse. ClickHouse supports row policies, and Postgres supports RLS, but using both means two different policy systems to configure, test, and keep in sync with per-request tenant context — more than the MVP team should take on while the schema is still moving.

## Decision
Enforce tenant isolation in **one application-layer mechanism across both databases**:

- **Postgres — mandatory scoped repository.** All access goes through a shared repository/query-builder layer that requires `store_id` (or `organization_id` for org-level tables) on every query. A lint rule forbids importing the ORM client or a raw SQL client outside this layer. Integration tests assert every repository method rejects a call without the tenant parameter.
- **ClickHouse — scoped query builder as the only API.** `packages/clickhouse` exposes a query builder that is the only permitted way to query ClickHouse; raw query strings are not accepted anywhere in application code (enforced by the same lint rule). The builder takes a tenant scope and injects a **parameterised** `store_id = {store_id:UUID}` predicate into every query. It does not inspect or string-match SQL.
- **System scope for cross-tenant jobs.** Jobs that legitimately span tenants — `retention`, scheduling of `order-status-reconcile`, suppression-set rehydration — must construct an explicit `SystemScope` with a stated reason. Each use writes an `audit_log` row (`actor_type='system'`, `action`, reason in `metadata`). No implicit unscoped access exists; a missing scope is a type error.
- **Tenant-prefixed keys and paths.** Report cache keys are `report:<store_id>:…`; S3 DSR export objects are `dsr-exports/<store_id>/<request_id>.json`; dedupe and suppression keys in Redis are store-prefixed (HLD §8). Code that builds these keys must take the tenant scope, not a bare string.
- **Not used for MVP:** Postgres RLS and ClickHouse row policies. Both are future defence-in-depth options, to be layered on top of — not instead of — the application-layer enforcement once the schema and access patterns stabilise.

## Consequences
- One enforcement model to review and test, covering both databases, caches, and object storage.
- No database-native backstop for MVP: a bug in the scoped layer is the single point of failure for isolation. Tracked as a risk in HLD §11; mitigated by the lint rule and by making §5.10 test 7 a mandatory CI gate on every PR touching the data-access layer.
- Cross-tenant operations are visible in `audit_log`, which supports S-4 and makes misuse of system scope detectable.
- Adding RLS or row policies later is additive, so this decision does not block future hardening.
- Every new table, query, cache key, or storage path added by any module must go through these layers — called out in the root `CLAUDE.md` and in each LLD's "Data owned" section.
