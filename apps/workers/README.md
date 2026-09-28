# apps/workers — Background workers

All BullMQ queue consumers and the `event-workers` Redis Stream consumer group named in HLD §8:
`ad-sync-meta`, `ad-sync-google-ads`, `shiprocket-sync`, `shopify-sync`, `identity-stitch`,
`attribution-run`, `capi-dispatch`, `order-status-reconcile`, `retention`, `dsr`.

Empty scaffold as of M0-1. Env validation at boot (Postgres, ClickHouse, durable Redis only —
no cache Redis) lands in M0-2. The queue consumers land starting M1-6 (event pipeline) and M2
(ad/logistics sync); see `docs/architecture/lld/event-pipeline.md`, `identity-stitching.md`,
`attribution-engine.md`.

## `event-workers` (M1-6, in slices)

Consumes `stream:events-raw` (`docs/architecture/lld/event-pipeline.md`).

- **M1-6a**: the building blocks — `sessionAssign.ts` (the `session_assign_v1` Lua script and its
  runner, one atomic Redis call per visitor per batch) and, in `packages/shared`, the pure classification
  and session rules (`events.ts`, `session.ts`).
- **M1-6b** (this slice): the consumer.
  - `eventConsumer.ts` — the loop: `XREADGROUP` in batches (1,000 entries or 1.5 s), in-process retry with
    backoff, `XACK` only after everything commits, and the 30 s reclaimer (`XAUTOCLAIM`; entries delivered
    5 times go to `stream:events-dead`).
  - `eventBatch.ts` — one batch: suppression re-check, dedupe, enrich, sessionise, classify; writes
    `events` / `touchpoints` / `identity_links` through the scoped ClickHouse builder, then Postgres
    (`consent_records`, `suppressed_identities`, the withdrawal erasure request, `orders.visitor_id`) in one
    transaction per store, then enqueues `dsr` jobs, then the Redis writes (suppression mirror, `checkout:`,
    `dedupe:`).
  - It fails closed: with `suppress:ready` absent nothing is read or written. **That marker is written by
    M1-6c** — until then a local pipeline stays paused (set `suppress:ready` by hand to develop against it).
  - `dsr` jobs are enqueued, but **nothing consumes the `dsr` queue until M4-2**, so a withdrawal's erasure
    does not complete yet.
- **M1-6c**: the suppression rebuild that writes `suppress:ready`.

The event-pipeline tests need the local Postgres, ClickHouse and durable Redis
(`docker compose up`). They isolate the global names (readiness marker, streams) per run and namespace
every other key by a freshly seeded store id.

## `shopify-sync` (M1-3, M1-3b)

The first queue consumer built. `backfill` starts a Shopify bulk order query; `bulk_result` streams its
JSONL and applies each order (hashing phone/email in memory, INR only) — see
`docs/architecture/lld/shopify-integration.md` §4.7 for the design and what is still deferred. Env:
Postgres, ClickHouse, durable Redis, the credentials-encryption keys, the identity-hashing keys and the
Shopify app config; it refuses to boot without any of them.

`bulk_result` is normally enqueued by the API when Shopify's `bulk_operations/finish` webhook arrives.
A laptop can't receive that webhook without a public tunnel, so locally use the operator tool (it
prints only non-secret state, never credentials):

```sh
pnpm --filter @truepath/workers dev            # the consumer (needs the env above in the root .env)
pnpm --filter @truepath/workers dev:backfill start  <storeId> [days]   # enqueue a backfill (default 60)
pnpm --filter @truepath/workers dev:backfill status <storeId>          # settings.backfill, incl. Shopify's own order count
pnpm --filter @truepath/workers dev:backfill apply  <storeId>          # enqueue bulk_result once the operation has finished
```

Compare `orders_applied` with `orders_reported` in `status`: they should match (minus any non-INR orders,
which the MVP skips). An operation still `RUNNING` makes `apply` fail and retry — just run it again.
