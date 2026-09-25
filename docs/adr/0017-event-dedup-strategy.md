# 0017. Event de-duplication strategy for `events` / `touchpoints`

## Status
Accepted

## Context
The Collector writes to a Redis Stream (`stream:events-raw`) consumed by the `event-workers` consumer group (HLD §4/§8). Consumer groups deliver **at least once**: if a worker dies after reading entries but before `XACK`, the entries stay in the Pending Entries List until `XAUTOCLAIM` hands them to another consumer, which processes them again. Without de-duplication the same `event_id` can be inserted into ClickHouse more than once, inflating session and touchpoint counts and skewing attribution credit.

SPEC §6.2 defines `events` as `MergeTree ORDER BY (store_id, visitor_id, occurred_at)` and gives `touchpoints` no `event_id` column, so there is no de-duplication today. `events`/`touchpoints` are the hottest read tables (every report touches them), so the solution should avoid `FINAL`/`argMax` on the normal report path.

Two options were considered:
- **A — `ReplacingMergeTree` only.** Consistent with `ad_spend_daily`/`identity_links`, survives restarts, no extra write-path component. But de-duplication is only eventual (background merges) unless reads use `FINAL`/`argMax`, which is costly on these tables.
- **B — Consumer-side dedupe key only.** No duplicate rows land in ClickHouse, so reports stay simple. But it adds a Redis round-trip per event, and the ordering of "mark seen" vs. "insert" determines whether it loses or duplicates events on a crash.

## Decision
Use **B as the primary mechanism, with A as a backstop**.

**Primary — post-insert dedupe key.** For each batch, `event-workers`:
1. Reads entries with `XREADGROUP`.
2. Skips any entry whose key `dedupe:<store_id>:<event_id>` already equals `'done'`.
3. Inserts the remaining entries into `events`/`touchpoints` as one batched insert per table.
4. **Only after the insert commits**, sets `dedupe:<store_id>:<event_id> = 'done'` with `EX 86400` (pipelined).
5. `XACK`s the batch.

Keys live on the durable (AOF, `noeviction`) Redis instance. The 24 h TTL is far longer than the `XAUTOCLAIM` min-idle (60 s) plus any realistic redelivery delay.

**Rejected ordering — `SETNX` before insert.** If the key is set first and the worker crashes before the insert commits, the redelivered entry is skipped as already-seen and the event is **permanently lost**. Setting the key after the insert turns that failure into, at worst, a duplicate — which the backstop removes. A two-state key (`'processing'` with a short TTL → `'done'`) would also avoid the loss, but adds a state and a TTL to tune without removing the need for the backstop, so the simpler post-insert ordering is chosen.

**Backstop — `ReplacingMergeTree`.** `events` and `touchpoints` use `ENGINE = ReplacingMergeTree ORDER BY (store_id, visitor_id, occurred_at, event_id)`. `touchpoints` gains an `event_id` column (the id of the event the touchpoint was derived from). Appending `event_id` as the last sort key keeps the `(store_id, visitor_id, occurred_at)` prefix, so visitor-journey queries use the primary index exactly as before. SPEC's `PARTITION BY toYYYYMM(occurred_at)` and TTL are unchanged; a duplicate always has the same `occurred_at`, so both copies land in the same partition and can merge.

**Remaining duplicate window.** Only a crash between step 3 and step 4 leaves a duplicate. It is collapsed at merge time. Reports do not use `FINAL` on these tables; the attribution run reads touchpoints with `FINAL` because it is scoped to a few visitors and must be exact.

## Consequences
- Normal report queries on `events`/`touchpoints` stay free of `FINAL`/`argMax`.
- No event is lost to the dedupe mechanism itself; the worst case is a short-lived duplicate.
- One extra pipelined Redis round-trip per batch (not per request), off the Collector's p95 < 50 ms path.
- Deviations from SPEC §6.2 — engine change and `touchpoints.event_id` — are listed in HLD §8's flagged-additions table.
- If durable Redis loses the dedupe keys, the backstop still converges; duplicates may be briefly visible until merges run.
- A periodic `count()` vs `uniqExact(event_id)` check per store/partition monitors residual duplicates (HLD Q13).
