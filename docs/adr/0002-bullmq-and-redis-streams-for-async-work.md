# 0002. BullMQ for jobs, a Redis Stream for ingestion, on two Redis instances

## Status
Accepted (BullMQ fixed in SPEC §3; the stream/queue split and Redis topology decided in HLD review)

## Context
SPEC §3 fixes BullMQ on Redis for ad syncs, backfills, attribution, CAPI dispatch and retention. SPEC §4's diagram labels the Collector → workers path "Redis stream / BullMQ" without choosing. Pixel events are high-volume and tiny; jobs need retries, delays, rate limits and dead-lettering. Losing a queued job or a stream entry means lost data, while report-cache entries are disposable.

## Decision
- **Ingestion**: the Collector `XADD`s to one Redis Stream, `stream:events-raw`, consumed by the `event-workers` consumer group:
  - batched ClickHouse writes, with `XACK` only after commit;
  - `XAUTOCLAIM` for orphaned entries; `MAXLEN ~` trimming; a lag alert;
  - poison entries to `stream:events-dead`.
- **Jobs**: BullMQ queues exactly as listed in HLD §8. Each has a `<queue>-failed` DLQ, exponential backoff and deterministic `jobId`s for idempotency and debouncing.
- **Two ElastiCache instances**:
  - **durable** (AOF, `noeviction`): stream, BullMQ, dedupe keys, suppression sets;
  - **cache** (`allkeys-lru`, no persistence): report cache, Better Auth rate-limit counters.

## Consequences
- The Collector does one Redis round trip and no per-event job overhead.
- At-least-once stream delivery requires de-duplication (ADR-0017).
- The durable instance is critical. If it is unreachable or its data is lost, the system fails closed (Collector `503`, workers pause) and the suppression set is rebuilt from Postgres (HLD §8). Lost un-acked entries are unrecoverable (HLD Q2).
- The eviction policy of the cache can never touch jobs or stream data.
