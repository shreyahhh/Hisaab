# 0026. Event workers act under a one-store TenantScope, not a SystemScope

## Status
Accepted (decided 2026-09-28 during M1-6 review). Refines [ADR-0016](0016-tenant-isolation-strategy.md); does not supersede it.

## Context
`event-workers` consumes one global stream, `stream:events-raw`, whose entries belong to many stores, so a single batch spans tenants. ADR-0016 says cross-tenant jobs must use an audited `SystemScope`, and lists `retention`, `order-status-reconcile` scheduling and suppression rehydration as examples. It does not say whether the event consumer is such a job. The LLDs are silent too. The choice matters because a `SystemScope` bypasses every store assertion in the scoped Postgres repositories, the scoped ClickHouse builder and the Redis key builders.

Options:
- **A. One long-lived `SystemScope`** for the consumer process (a new `SystemReason`, one audit row at startup). Simple, and one ClickHouse insert per table per batch is possible. But every write the consumer makes is then unscoped: a bug that mixes up `store_id` between two entries in a batch would silently write another tenant's data, and nothing would catch it.
- **B. One `TenantScope` per store, per operation** (`storeBoundScope(storeId)`, `role: 'job'`, covering exactly that store — the scope the Collector already builds). Every repository call, ClickHouse insert and key builder still asserts the store is in scope, so a cross-store mix-up throws instead of writing. No audit row per batch is needed, because nothing crosses a tenant boundary within a single operation.

## Decision
**Option B.** `event-workers` groups each batch by `store_id` and performs every read and write for a store under a `TenantScope` that covers only that store. It never holds a `SystemScope`. Postgres repositories are called with that scope; Redis keys are built by the key builders with it; ClickHouse goes through `ch(client, scope, storeId).insert(...)`.

The suppression rebuild is different in kind — it must read every store's entries — and does use an audited `SystemScope` (reason `suppression_rebuild`, M1-6c).

## Consequences
- A cross-store mix-up in the pipeline fails loudly (`TenantScopeViolationError`) instead of writing to the wrong tenant. This is the property ADR-0016 exists to provide, kept for the hottest write path.
- **Per-store inserts (the trade-off).** The scoped ClickHouse builder is per store, so a batch issues one `INSERT` per table **per store** rather than one per table (event-pipeline.md §4.1 step 10 originally said one per table). ClickHouse prefers few, large inserts; many small ones create many parts. With the MVP store count (3–5 design partners) this is a handful of inserts per flush and is fine. At a large store count the write path would create up to `stores × 3` parts per 1.5 s flush.
- **Revisit trigger:** if flush cost or part count becomes a problem, add a multi-store insert to the scoped builder that validates every row's `store_id` against an explicit allowed set (still not a `SystemScope`), or shard consumers by store. That is additive and does not need to supersede this ADR.
- The stream itself is still global (`stream:events-raw` is one of HLD §8's documented key exceptions), so the consumer necessarily reads entries of every store; scoping applies to what it *does* with them.
- Each new worker that consumes a multi-store queue should follow the same rule unless it genuinely needs to read across tenants (retention, reconcile fan-out, rebuild), in which case it uses an audited `SystemScope`.
