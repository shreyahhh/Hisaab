# apps/collector — ingest collector

`POST /v1/collect` receives the pixel's consent-gated batches and appends them to `stream:events-raw`
(SPEC §7.2, `docs/architecture/lld/collector.md`). Stateless. It depends only on **durable Redis**: no
Postgres connection, and it never touches ClickHouse (a boot test pins this).

## What one request does (LLD §4)

1. Per-IP rate limit → `429`; body ≤ 10,240 bytes → `413`.
2. Looks up `collector:store:<store_key>` (cached 30 s, misses too) → `401 unknown_store_key`.
3. Verifies `HMAC-SHA256(secret[kid], "<ts>.<rawBody>")` over the **raw** body, `ts` within ±300 s
   (two `kid`s accepted during a rotation) → `401`.
4. `Origin`: absent or `null` (the pixel sandbox) passes; a foreign origin → `403`. Each event's page host
   must be one of the store's hosts, else the event is dropped (`foreign_page`).
5. Validates `CollectBatch` (strict — an unknown key is rejected, so nothing can smuggle PII) → `400`.
6. **Consent**: an `inactive` store drops everything; without analytics consent only `consent_*` events are
   forwarded. `fbp`/`fbc` are kept only with marketing consent and never for a child-directed store.
7. **Minimise**: phone/email hashed to versioned HMACs (raw values live only inside that call); the IP is
   used for the rate limit and geo, then dropped; the user agent is parsed to device/browser/OS and dropped;
   URLs are sanitised (allow-listed campaign params only, checkout tokens masked); events older than 24 h are
   dropped, ones from the future clamped.
8. **Suppression + append, atomically** (`collector_ingest_v1`, one Lua round trip):
   - `suppress:ready` missing → `503 suppression_unavailable`, nothing appended (fail closed).
   - Erased visitor → the whole batch dropped, consent events included.
   - An erased **identity** on a new device → the visitor is suppressed, a `suppression_hit` is appended, and the
     **whole** batch (earlier events too) is dropped.
   - Withdrawn visitor → non-consent events dropped, consent events forwarded (re-consent works).
9. `204` — including when everything was dropped: the response never reveals consent or suppression state.

Drops are counted per reason in `stats:collector:<store_id>:<yyyymmdd>` (IST day). Logs carry store id,
status, reason and latency only — never the body, the query string (it holds the signature), the visitor id,
the IP or the user agent.

## Stream entries

Two fields per entry, both kinds: `store_id` and `payload` (JSON; `StreamEventEntry` or
`StreamSuppressionHit` in `packages/shared/src/stream.ts`). One shape means a consumer parses every entry the
same way — a small refinement of collector.md §2.4, which left `suppression_hit`'s fields loose.

## Endpoints

`POST /v1/collect`, `OPTIONS /v1/collect`, `GET /healthz`, and `GET /readyz` (durable Redis reachable **and**
`suppress:ready` present **and** geo ready).

## Running

```sh
pnpm --filter @truepath/collector dev      # needs REDIS_DURABLE_URL and the IDENTITY_* keys in the root .env
```

The Collector answers `503` until `suppress:ready` exists; the `event-workers` service writes it after
rebuilding the suppression sets from Postgres (M1-6).

## Not built yet

- **Geo.** The plan is the DB-IP Lite database (approved, SPEC §3), but reading `.mmdb` needs a reader library
  that is not on the approved list. Until then `geo_state`/`geo_city` are `''` — the same value a lookup miss
  produces, so nothing downstream changes when it lands. The interface is `geo.ts`.
- Deployment (own ALB with access logs off, Fargate) — infrastructure, not this ticket.
- The 500 events/s load test (SPEC M4-6); the rate-limit numbers are placeholders until then.

## Tests

`collect.test.ts` runs the real Fastify app against real Redis and the real Lua script. The two **global** Redis
names (the readiness marker and the stream) are isolated per test run through an injectable `redisKeys` seam, so
a test can never write to, or delete the marker of, a developer's live local pipeline.
