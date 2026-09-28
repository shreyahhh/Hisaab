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
  - It fails closed: with `suppress:ready` absent nothing is read or written (the marker is written by
    M1-6c, below).
  - `dsr` jobs are enqueued, but **nothing consumes the `dsr` queue until M4-2**, so a withdrawal's erasure
    does not complete yet.
- **M1-6c**: `suppressionRebuild.ts` — reloads the suppression sets from Postgres (`suppressed_identities`)
  into Redis and then writes `suppress:ready`, at Workers startup and whenever the marker goes missing
  (checked every 10 s) and republishes every store's `collector:store:*` config (#56). While the marker is missing `shopify-sync` and `identity-stitch` are paused. See `privacy-dpdp.md` §4.9. Needs `DPA_VERSION` in the Workers environment.

The event-pipeline tests need the local Postgres, ClickHouse and durable Redis
(`docker compose up`). They isolate the global names (readiness marker, streams) per run and namespace
every other key by a freshly seeded store id.

## `ad-sync-meta` — `meta-warmup` slice (M1-8)

Builds the Marketing API call history Advanced Access / App Review needs, ahead of the real Meta OAuth connect (M2-1). See `docs/architecture/lld/meta-integration.md` §2.2 and ADR-0027.

- No connect flow yet: register a store's ad account and access token by hand (stdin, never argv):
  ```sh
  pnpm --filter @truepath/workers dev:meta-warmup register <storeId> <adAccountId> <name> <currency> <timezone>
  pnpm --filter @truepath/workers dev:meta-warmup start  <storeId>   # registers the repeatable 15-min job
  pnpm --filter @truepath/workers dev:meta-warmup run    <storeId>   # enqueues one immediate run, to check it works
  pnpm --filter @truepath/workers dev:meta-warmup status <storeId>   # prints non-secret state (ad accounts, the ledger)
  ```
- `metaWarmup.ts` — `runMetaWarmup` pulls `GET act_<id>/insights` for every account the store has registered (`packages/integrations` `createMetaAdapter`), writes what it gets to ClickHouse `ad_spend_daily`, and keeps a running success/error ledger in `integrations.settings.warmup`. One account failing doesn't stop the others; each run is logged (`meta_warmup_run`) with the ledger totals — there is no live dashboard yet (issue tracked).
- At Workers boot, every store already registered gets its repeatable job re-registered (idempotent); a store registered *after* boot needs the `start` command until this is rescanned some other way.
- No shopper data is involved, so this worker is never paused by the suppression rebuilder.

## `identity-stitch` (M1-7)

Links each order to the visitor(s) whose journey it belongs to (`docs/architecture/lld/identity-stitching.md`).

- `identity/stitch.ts` — `stitchOrder` and the BullMQ processor. Rule order: the order's own visitor (`orders.visitor_id`, then the `checkout:` key), the phone/email HMAC fallback, retries at +5 and +30 min, then the UTM fallback (`attribution_confidence='low'`, never downgrading a `high`). The suppression gate runs when the job runs, so a delayed attempt for a shopper erased meanwhile does nothing. While `suppress:ready` is missing the worker is paused and a job in flight is delayed, not failed. The last failure of a job goes to `identity-stitch-failed`.
- `identity/journey.ts` — `findLinkedVisitors` (the shared-identifier guard: > 20 visitors or > 50 orders in 90 days on one hash is ignored) and `resolveJourneyVisitors` (primary first, capped at 10), which attribution will call.
- Enqueued by the API after an order webhook is applied (attempt 0) and by the `shopify-sync` backfill (attempt 2). It enqueues `attribution-run` jobs, **whose consumer lands with M3-2** — until then they wait.

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
