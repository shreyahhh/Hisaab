# LLD — Event pipeline (`event-workers`)

> Names are defined in [HLD §8](../HLD.md#8-cross-cutting-concepts) and used here verbatim. De-duplication follows [ADR-0017](../../adr/0017-event-dedup-strategy.md). Input entries are produced by the [Collector](collector.md).

## 1. Purpose & scope

`event-workers` is the consumer group on `stream:events-raw`. For each batch of entries it:
1. re-checks suppression and dedupe;
2. enriches each event (parses UTMs and click ids from the sanitised URL, builds `fbc` when needed);
3. assigns a server-side session (SPEC §7.1: "final sessionisation done server-side");
4. builds one touchpoint per session start and classifies its channel (SPEC §7.4 plus `channel_rules`);
5. maps campaign, ad set and ad ids from UTM conventions;
6. writes `events`, `touchpoints` and event-derived `identity_links` to ClickHouse in batches;
7. writes `consent_records` and suppression entries, and handles `suppression_hit`;
8. records the checkout → visitor handoff for identity stitching;
9. `XACK`s only after all writes commit, and reclaims or dead-letters stuck entries.

**Non-goals**
- Order ↔ visitor stitching and the delayed re-stitch attempts — [identity-stitching.md](identity-stitching.md). This module only provides the event-side inputs: `identity_links` rows from contact events and the `checkout:` key.
- Attribution — [attribution-engine.md](attribution-engine.md).
- Consent evaluation and hashing — already done by the Collector with `packages/privacy`.
- Channel-rule editing UI and API — [reporting-api.md](reporting-api.md) / [dashboard.md](dashboard.md). This module only reads `channel_rules`.

## 2. Interfaces

### 2.1 Input
`StreamEventEntry` and `StreamSuppressionHit` from `packages/shared/stream.ts` ([collector.md §2.4](collector.md#24-output--stream-entry-packagessharedstreamts)). Entries are re-validated with the matching zod schemas. A failure counts as a poison delivery (§5).

### 2.2 Internal types (`packages/shared/events.ts`)

```ts
export type Channel =
  | 'meta_ads' | 'google_ads' | 'organic_search' | 'email' | 'whatsapp'
  | 'influencer_affiliate' | 'organic_social' | 'direct' | 'referral' | 'other_campaign';   // HLD §8

export type ClickIdType = 'fbclid' | 'gclid' | 'gbraid' | 'wbraid' | '';

export type Landing = {
  utm_source: string; utm_medium: string; utm_campaign: string; utm_content: string; utm_term: string;  // lowercased, trimmed; '' if absent
  fbclid: string; gclid: string; gbraid: string; wbraid: string;
  referrer_host: string;          // lowercased host of the sanitised referrer, 'www.' stripped
};

export type Classification = {
  channel: Channel; sub_channel: string;
  platform: 'meta' | 'google' | null;
  campaign_id: string; adset_id: string; ad_id: string;
  click_id_type: ClickIdType; is_direct: 0 | 1;
};

export function classify(l: Landing, rules: ChannelRule[], ctx: { shopHosts: string[] }): Classification;
```

### 2.3 `channel_rules.match` schema (read-only here)

```ts
const Field = z.enum(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'referrer_host', 'click_id_type']);
const Condition = z.object({
  field: Field,
  op: z.enum(['eq', 'in', 'contains', 'starts_with', 'present', 'absent']),
  value: z.union([z.string().max(128), z.array(z.string().max(128)).max(50)]).optional(),
}).strict();
export const ChannelRuleMatch = z.object({
  all: z.array(Condition).max(10).optional(),
  any: z.array(Condition).max(10).optional(),
}).strict().refine(m => (m.all?.length ?? 0) + (m.any?.length ?? 0) > 0);

export type ChannelRule = { id: string; priority: number; match: z.infer<typeof ChannelRuleMatch>;
                            channel: Channel; sub_channel: string };
```

Comparisons are case-insensitive on trimmed values. A rule that fails validation is skipped; its `id` is logged, and the health screen shows "1 channel rule ignored".

### 2.4 Outputs
- **ClickHouse `events`**: one row per accepted `kind:'event'` entry (the SPEC §6.2 columns; no raw user agent — SPEC v0.5). `events.properties` is `JSON.stringify(entry.properties)`, which is already allowlisted.
- **ClickHouse `touchpoints`**: one row per session start, with `event_id` (HLD §8).
- **ClickHouse `identity_links`**: one row per `(visitor_id, hash)` for each of `phone_hmac` and `email_hmac` on `checkout_contact_info_submitted` / `checkout_completed`, with `first_seen = last_seen = occurred_at`.
- **Postgres `consent_records`**: per `consent_*` event ([privacy-dpdp.md §4.2](privacy-dpdp.md#42-consent-evidence)).
- **Postgres `suppressed_identities`** plus the Redis sets: on `consent_withdrawn` and `suppression_hit`.
- **Postgres `orders.visitor_id`** and Redis `checkout:<store_id>:<order_id>`: on `checkout_completed`.
- **BullMQ `dsr`**: `DsrJob{storeId, type:'erasure', requestId, visitorIds:[visitor_id]}` on `suppression_hit`.

No REST endpoints.

## 3. Data owned

| Item | Access | Notes |
|---|---|---|
| `stream:events-raw` | `XREADGROUP` / `XACK` / `XAUTOCLAIM` / `XPENDING` | group `event-workers`, consumers `event-workers:<ecs-task-id>` |
| `stream:events-dead` | `XADD` | poison entries (HLD §8) |
| `dedupe:<store_id>:<event_id>` | `MGET`, then `SET … EX 86400` | ADR-0017 |
| `session:<store_id>:<visitor_id>` | Lua read-modify-write, `EX 7200` | HLD §8 |
| `checkout:<store_id>:<order_id>` | `SET … EX 86400` | HLD §8; read by identity-stitch |
| `suppress:*` | read; write via `SuppressionClient` | HLD §8 |
| ClickHouse `events`, `touchpoints` | batched insert | `ReplacingMergeTree`, `ORDER BY (store_id, visitor_id, occurred_at, event_id)` |
| ClickHouse `identity_links` | batched insert | `ReplacingMergeTree(last_seen)`; the write function is owned by identity-stitching |
| Postgres `consent_records`, `suppressed_identities` | insert (`ON CONFLICT DO NOTHING`); delete the `withdrawn` entry on re-grant | |
| Postgres `orders` | `UPDATE … SET visitor_id` where it is still null | the only column touched |
| Postgres `channel_rules`, `stores` | read (cached 60 s per store) | `stores.shop_domain` for own-domain referrer detection |

No additions beyond HLD §8.

## 4. Processing flow

### 4.1 Batch loop (per consumer)
1. `XREADGROUP GROUP event-workers <consumer> COUNT 500 BLOCK 500 STREAMS stream:events-raw >`. Append to the in-memory batch.
2. Flush when the batch reaches **1,000 entries** or **1.5 s** has passed since its first entry, whichever comes first.
3. Wait until `suppress:ready` is present; otherwise pause the loop (HLD §8 fail-closed) without reading more.
4. Group entries by `store_id` and load each store's cached `channel_rules` and shop hosts.
5. **Suppression re-check** (one pipelined round trip): `ZSCORE` on the erased and withdrawn visitor sets for `HMAC(visitor_id)` (every read key version), and on the erased identity set for the entry's phone, email and identity hashes. Mark suppressed entries as drop-and-ack. `consent_*` entries skip the withdrawn check.
   - **Erased identity found here** (an erasure that landed after the Collector's check): the visitor is treated as a `suppression_hit` — erased suppression entry, follow-up purge — and none of its events in the batch are stored (M1-6b).
   - **Withdrawal in the same batch**: a visitor's non-consent events later than its `consent_withdrawn` in the same batch are dropped too (they would be erased minutes later anyway).
6. **Dedupe** (one `MGET` of `dedupe:<store_id>:<event_id>`): mark entries whose key is `'done'` as ack-only.
7. **Enrich**: parse `Landing` from `page_url` and `referrer`. If `fbclid` is present and `fbc` is empty, set `fbc = "fb.1." + <occurred_at ms> + "." + fbclid`. This follows Meta's server-side rule: `subdomainIndex = 1`, and `creationTime` in ms is when the `fbclid` was first seen, i.e. the landing event's `occurred_at` ([fbp and fbc](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc)). **Only when the event carries `ad_platform_measurement`** (M1-6b): the Collector strips the pixel's own `fbc` without that purpose, and deriving one here must not sidestep it. Consent events carry no landing semantics: their UTM and click-id columns are stored empty.
8. **Sessionise** (§4.2): one Lua call per visitor in the batch, with that visitor's entries sorted by `occurred_at`. It returns a `session_id` per event and the events that start a session.
9. **Build touchpoints**: for each session-start event, call `classify(landing, rules, ctx)` (§4.3) and emit a `touchpoints` row with `event_id = <that event>`.
10. **ClickHouse writes**: one `INSERT` per table (`events`, `touchpoints`, `identity_links`) **per store** in the batch, through the scoped query builder (`ch(client, scope, storeId).insert`, ADR-0016; one-store scope per ADR-0026), which sets `wait_end_of_query=1` and `async_insert=0` on every insert. Not `async_insert`: we need to know the insert committed before `XACK`. (Per store rather than per batch, because the builder is scoped to one store; with MVP's store count that is the same handful of inserts.)
11. **Postgres writes**, in one transaction per store:
    - `consent_records` inserts;
    - `suppressed_identities` inserts;
    - removal of `withdrawn` entries on `consent_granted`;
    - `UPDATE orders SET visitor_id=$v WHERE store_id=$s AND external_order_id=$o AND visitor_id IS NULL` for each `checkout_completed`.
12. **Redis writes** (pipelined, **after step 13**):
    - `ZADD` / `ZREM` mirroring step 11's suppression changes;
    - `SET checkout:<s>:<order_id> <visitor_id> EX 86400`;
    - `SET dedupe:<s>:<event_id> done EX 86400` for every written entry.
13. **Jobs** (run *before* step 12, M1-6b): with the dedupe keys written first, a retry after a failed enqueue would find a withdrawal's consent event already `done`, skip it, and its erasure job would never be enqueued. A retry re-enqueues, and the job ids de-duplicate.
    - For each `suppression_hit`, look up `suppressed_identities.dsr_request_id` for the identity and enqueue `DsrJob{…, visitorIds:[visitor_id]}` with `jobId = dsr-followup-<requestId>-<suppression row id>`. A hit whose identity has no matching erased entry (possible only across a key rotation, when the hit's hash is under a different key version) is still suppressed but enqueues no purge, and is counted as `suppressionHitsUnmatched`.
    - For each `consent_withdrawn`, enqueue `DsrJob{storeId, type:'erasure', requestId}` (60 s delay, `jobId = dsr-<requestId>`).
    - Job ids use `-`, not `:` (M1-6b): BullMQ rejects a custom id containing `:` unless it has exactly three parts, and an id built from the visitor's HMAC would put an identifier into ids that are logged.
14. `XACK stream:events-raw event-workers <all ids in batch>`, including dropped, ack-only and suppression-hit entries.
15. Emit metrics: batch size, flush reason, per-step duration, drops by reason (no identifiers as labels).

A failure in steps 10–13 aborts the batch **without** `XACK` (§5).

```mermaid
sequenceDiagram
  participant S as stream:events-raw
  participant W as event-workers
  participant R as Redis durable
  participant CH as ClickHouse
  participant PG as Postgres
  participant Q as BullMQ dsr
  loop until 1,000 entries or 1.5 s
    W->>S: XREADGROUP COUNT 500 BLOCK 500
  end
  W->>R: suppress:ready? ZSCORE suppression; MGET dedupe keys
  W->>W: enrich (UTM, click ids, fbc)
  W->>R: EVALSHA session_assign_v1 per visitor
  W->>W: classify session starts → touchpoints
  W->>CH: INSERT events / touchpoints / identity_links (one per table)
  W->>PG: consent_records, suppressed_identities, orders.visitor_id (txn per store)
  W->>R: ZADD/ZREM, SET checkout:*, SET dedupe:* 'done'
  W->>Q: DsrJob follow-ups for suppression_hit
  W->>S: XACK batch
```

### 4.2 Sessionisation (`session_assign_v1`, Lua, atomic per visitor)
State `session:<store_id>:<visitor_id>` = `{session_id, last_at, campaign_fp, start_ref}`.
- `campaign_fp` is a fingerprint of the landing's campaign parameters: `utm_source|utm_medium|utm_campaign|utm_content|utm_term|click id value`, or `''` when none are present.
- `start_ref` is the external referrer host of the event that started the session (`''` if none). Rule 4 below needs it to tell "the same referrer" from a new one; HLD §8 originally listed only the first three fields (`start_ref` added in M1-6a).

For each event, in `occurred_at` order, a **new session** starts when any of these is true:
1. no state exists;
2. `occurred_at − last_at > 30 min` (SPEC §7.1);
3. the event carries campaign params and their fingerprint differs from `campaign_fp`;
4. the referrer is external and not ignorable (see §4.3 ignorable hosts), and the previous session was not started by the same referrer host.

Rules 2–4 apply only to an event that is not older than `last_at`; an older one joins the current session (see below). Otherwise the event joins the current session. A new session gets a server-generated UUID v7 `session_id`, supplied to the script as an argument (the script generates nothing).

The pure reference implementation is `assignSession` in `packages/shared/src/session.ts`; the Lua script (`apps/workers/src/sessionAssign.ts`) applies the same rules atomically, and a differential test runs both over random sequences. `last_at = max(last_at, occurred_at)`, and the key expires after 7,200 s.

Consent events never start a session (they carry no landing semantics).

**Late consent and replay.** Shopify runs app-pixel callbacks only after consent and then replays previously registered events ([Shopify: pixels — Requesting consent](https://shopify.dev/docs/apps/build/marketing/pixels)). So a batch typically arrives as `consent_granted`, then replayed `page_viewed` / `product_viewed` with earlier `occurred_at` values.
- Because entries are sorted by `occurred_at` per visitor before `session_assign_v1` runs, and consent events don't start sessions, the replayed landing event becomes the session start. Its UTMs and click ids become the touchpoint.
- **Landing attribution survives late consent.**
- If a *later* page event is processed before the replayed landing event (for example on another consumer), the landing event joins that session under the out-of-order rule, and the session's touchpoint would come from the later page instead. That edge case is on the dev-store replay test ([collector.md Q3](collector.md#9-open-questions)). An event older than `last_at` (out of order across consumers) joins the current session and never starts one. This is the accepted imprecision of running more than one consumer.

### 4.3 Channel classification
`classify` evaluates the store's `channel_rules` by ascending `priority`; the first match wins. If none match, it applies the defaults below, top to bottom (SPEC §7.4, ordered so explicit UTMs beat referrer inference).

**Ignorable referrer hosts** are treated as "no referrer": the shop's own hosts; `checkout.shopify.com` and `shop.app`; and payment-gateway return hosts (`razorpay.com`, `api.razorpay.com`, `payu.in`, `secure.payu.in`, `cashfree.com`, `paytm.com`, `securegw.paytm.in`, `phonepe.com`, `ccavenue.com`, `gokwik.co`, `shopflo.co`). They are ignorable so a return from a payment page doesn't start a new "referral" session that steals last-click credit.

| # | Condition | channel | sub_channel | platform | click_id_type |
|---|---|---|---|---|---|
| 1 | `fbclid` present, or `utm_source ∈ {facebook, fb, instagram, ig, meta}` and `utm_medium ∈ {cpc, paid, paid_social}` | `meta_ads` | `utm_source` or `facebook` | `meta` | `fbclid` if present |
| 2 | `utm_source ∈ {facebook, fb, instagram, ig, meta}` (other mediums) | `organic_social` | `utm_source` | null | — |
| 3 | `gclid` / `gbraid` / `wbraid` present, or `utm_source=google` and `utm_medium=cpc` | `google_ads` | `utm_medium` or `cpc` | `google` | the id present, in the order gclid, gbraid, wbraid |
| 4 | `utm_medium = email` | `email` | `utm_source` | null | — |
| 5 | `utm_source ∈ {whatsapp, wa}` | `whatsapp` | `utm_medium` | null | — |
| 6 | `utm_medium ∈ {influencer, affiliate}` | `influencer_affiliate` | `utm_source` | null | — |
| 7 | any `utm_*` present (no rule above matched) | `other_campaign` | `utm_source` | null | — |
| 8 | referrer host matches `google.*` or `bing.com` (no click id) | `organic_search` | host | null | — |
| 9 | referrer host ∈ {instagram.com, l.instagram.com, facebook.com, m.facebook.com, l.facebook.com, lm.facebook.com} | `organic_social` | host | null | — |
| 10 | other non-ignorable referrer | `referral` | host | null | — |
| 11 | no referrer, no params | `direct` | `''` | null | — |

`is_direct = 1` only for `direct`.

**Campaign mapping** (SPEC §7.4 conventions; the onboarding URL templates are specified in [dashboard.md](dashboard.md)):

| platform | `campaign_id` | `adset_id` | `ad_id` | Recommended template |
|---|---|---|---|---|
| meta | `utm_campaign` | `utm_content` | `utm_term` | `utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.id}}&utm_content={{adset.id}}&utm_term={{ad.id}}` |
| google | `utm_campaign` | `utm_content` | `utm_term` | `utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_content={adgroupid}&utm_term={creative}` |

- A value is used only if it matches `^\d{1,24}$` (both platforms use numeric ids).
- A non-numeric value (a campaign *name*) leaves the id empty. The raw UTMs remain on `events`, so the "UTM health" check can report "Meta traffic without campaign ids: 23%".
- Performance Max traffic (a `gclid` with `utm_content` empty) maps at campaign level only, matching `ad_spend_daily`'s synthetic `ad_id='pmax:<campaign_id>'` (HLD §8). The reporting join handles that mapping; this module leaves `ad_id` empty.

### 4.4 Consent, withdrawal and `suppression_hit` handling
- `consent_granted` → a `consent_records` row with `state='granted'` and `purposes = consent_purposes`. If a `withdrawn` suppression entry exists for the visitor → `removeWithdrawn`, **only when the grant includes `attribution_analytics`** (a marketing-only grant doesn't bring a withdrawn visitor back).
- The consent event's `notice_version` comes from the stream entry: the Collector sets it on consent events (M1-6b; optional in `StreamEventEntry`, so older entries still validate — a missing one is recorded as `'unknown'`).
- `consent_withdrawn` → a `consent_records` row with `state='withdrawn'`, a `withdrawn` suppression entry (`expires_at = now + 13 months`), and — in the same Postgres transaction — a `dsr_requests` erasure row with `trigger='consent_withdrawn'`, plus a `DsrJob` enqueued in step 13 ([privacy-dpdp.md §4.5](privacy-dpdp.md#45-withdrawal-triggered-erasure-dpdp-s87)).
- A partial change (marketing withdrawn, analytics kept) arrives as `consent_granted` with `purposes = ['attribution_analytics']`. Because CAPI reads the *latest* record, this stops CAPI for the visitor.
- `suppression_hit` → an `erased` visitor suppression row in Postgres (the Collector already `ZADD`ed the hot copy), then the follow-up `DsrJob`. It is never written to `events`.
- Every consent event is also written to `events`, as evidence alongside `consent_records`.
- `consent_records.source` records the trigger (SPEC v0.6): `pixel_interaction` | `pixel_initial_state` | `pixel_refresh`.
- **Default-on signal** (HLD §8 *Consent-region gate*):
  - For each `visitor_new` batch, `HINCRBY stats:collector:<store_id>:<yyyymmdd> new_visitors 1`.
  - If that batch has analytics allowed and **no** `consent_granted` with `trigger='interaction'`, also `HINCRBY … new_visitors_initial_only 1`.
  - At most every 10 min per store (in-process timestamp), the worker reads the last 2 days' hashes and evaluates the thresholds:
    - **warn** at ratio ≥ 0.2 over ≥ 50 new visitors in 24 h → `stores.privacy_config.consent_health = {status:'warn', ratio, measured_at}`;
    - **auto-pause** at ratio ≥ 0.5 over ≥ 100 new visitors, sustained 48 h → `consent_health.status = 'paused'`, `paused_at`; republish the collector config `inactive` with `inactiveReason = consent_default_on_detected`; SES email to owners/admins; audit `consent_default_on_paused`.
  - Enforcement of the pause is behind a feature flag until the dev-store test (collector.md Q3c) confirms the signal separates opt-in from default-on stores.

### 4.5 Reclaimer and poison handling (every 30 s, in each consumer)
1. `XAUTOCLAIM stream:events-raw event-workers <self> 60000 0-0 COUNT 500`. Claimed entries join the next batch.
2. `XPENDING stream:events-raw event-workers - + 500` → entries with delivery count ≥ 5 are poison. `XADD stream:events-dead MAXLEN ~ 100000 * reason <code> source_id <id> payload <json>`, then `XACK` the original and raise the alert `event_pipeline_poison`.
3. Consumers idle > 1 h with no pending entries are removed with `XGROUP DELCONSUMER`.

## 5. Failure modes

| Failure | Behaviour | Idempotency / recovery |
|---|---|---|
| ClickHouse insert fails or times out (30 s) | No `XACK`. Retry the same batch in-process with backoff 1, 2, 4, 8, 16, 30 s. If ClickHouse is down > 5 min, stop reading new entries; the stream buffers, and alert `clickhouse_unavailable` | `ReplacingMergeTree` absorbs a partially committed retry |
| Postgres transaction fails after the ClickHouse insert | No `XACK`; retry the batch. The ClickHouse re-insert collapses (ADR-0017 backstop); Postgres inserts are `ON CONFLICT DO NOTHING`; the `orders` update is guarded by `visitor_id IS NULL` | Safe to repeat |
| Crash after inserts, before `SET dedupe` | Redelivered after 60 s via `XAUTOCLAIM`, then re-inserted and collapsed at merge | ADR-0017 |
| Crash before inserts | Redelivered; nothing to undo | — |
| Redelivered event gets a different `session_id` than the first time (session state moved on) | The last insert wins after the merge, so its session could be assigned differently | In-process retries re-use the batch's session assignments (M1-6b), so only a redelivery after a process crash can differ: rare, limited to the events of one batch |
| Poison entry (schema mismatch, deterministic exception) | Moved to `stream:events-dead` after 5 deliveries; alert | Replay via an ops script after fixing |
| `suppress:ready` absent | Loop paused (no reads) | Resumes after the rebuild (HLD §8) |
| Invalid `channel_rules` row | Rule skipped, defaults apply, health-screen notice | Fix via the API |
| Stream lag grows | Alerts: consumer-group `lag` > 30,000 entries, or oldest pending > 5 min, or `XLEN > 1,500,000` ([collector.md §7](collector.md#7-performance--limits)) | Scale consumers; lag must be cleared before `MAXLEN` trimming would drop unprocessed entries |
| `DsrJob` enqueue fails | Batch not acked, retried | `jobId` dedupes |

## 6. Privacy touchpoints

| ID | Where |
|---|---|
| P-1 / P-5 | Only entries the Collector accepted arrive. `consent_purposes` is written to `events` and used downstream for purpose checks. |
| P-3 | Withdrawal writes a `consent_records` row and a `withdrawn` suppression entry. The suppression re-check (step 5) drops any entry that was already in the stream when the withdrawal landed. |
| P-4 | `consent_records` written with `HMAC(visitor_id)` and idempotent `id = event_id`. |
| §5.4 | No raw phone or email ever reaches this module; `identity_links` stores HMACs only; `events.properties` is allowlisted by the Collector's strict schemas; the raw UA never arrives (parsed and discarded by the Collector). |
| Erasure | Suppression re-check at execution (HLD §8). `session:` / `checkout:` keys and `stream:events-dead` are covered by the erasure job ([privacy-dpdp.md §4.4](privacy-dpdp.md#44-dsr--erasure-hld-6d-and-follow-up)). `suppression_hit` triggers the follow-up purge. |
| §7.3 rule 5 | Every write and every key includes `store_id`; `identity_links` rows are per store; ClickHouse is accessed only through the scoped query builder (ADR-0016). |
| Logs | Batch-level metrics only. Entry payloads, `visitor_id` and hashes are never logged; poison details go to `stream:events-dead`, not to logs. |

## 7. Performance & limits

| Item | Target |
|---|---|
| Flush | ≤ 1,000 entries or 1.5 s |
| Batch processing time | p95 < 500 ms for 1,000 entries (excluding ClickHouse latency spikes) |
| Freshness | pixel `204` → visible in ClickHouse < 5 s in steady state (SPEC §13: < 5 min) |
| ClickHouse insert rate | ≤ ~1 insert/s per table per consumer; at 500 events/s one consumer suffices. Run 2 consumers for HA |
| Redis round trips per batch | ~5 (suppression, dedupe, session Lua per visitor pipelined, writes, `XACK`) |
| `channel_rules` per store | ≤ 100 rules (enforced at the API); cached 60 s |
| Session state memory | ~200 bytes/visitor × active visitors in 2 h |
| Reclaim | `XAUTOCLAIM` min-idle 60 s, every 30 s |

## 8. Test plan

**Unit**
- `classify`: table-driven over every SPEC §7.4 row plus these edge cases:
  - `fbclid` + `utm_medium=email` → `meta_ads`;
  - Razorpay return referrer → no new session and no referral;
  - `utm_source=Instagram ` (case and whitespace) → normalised;
  - unmatched UTMs → `other_campaign`;
  - merchant rule overriding a default.
- Campaign mapping: numeric vs name values; PMax (`gclid`, no `utm_content`).
- Session rules: 29 vs 31 min gap; campaign change within 5 min; out-of-order event; consent event never starts a session.
- Property test (fast-check): `classify` is deterministic and total (always returns a valid `Channel`).

**Integration** (Redis, ClickHouse, Postgres testcontainers)
- End-to-end: Collector `inject` → worker → rows in `events` and `touchpoints` with the expected session and channel.
- Crash injection after the ClickHouse insert, before `SET dedupe` → after `OPTIMIZE … FINAL`, `count() = uniqExact(event_id)` (HLD Q13).
- Crash before the insert → no loss.
- Poison entry → `stream:events-dead` after 5 deliveries.
- `consent_withdrawn` → `consent_records` row, withdrawn suppression; the next `page_viewed` already in the stream is dropped at step 5.
- `suppression_hit` → Postgres erased row plus a `DsrJob` with `visitorIds`.
- `checkout_completed` before the order webhook → `checkout:` key set, and `orders.visitor_id` filled once the order exists.
- Batching: 1,000 entries flush immediately; 10 entries flush at 1.5 s.

**§5.10 compliance tests supported**
- Test 2 (withdrawal): pipeline half.
- Test 3 (no raw PII in ClickHouse): scan over `events` / `touchpoints` / `identity_links` after the seeded run.
- Test 4 (no PII in logs): log scan.
- Test 5 (erasure incl. new device): the follow-up path.
- Test 7 (cross-tenant): the query builder rejects writes without a scope.

## 9. Open questions

1. *(resolved 2026-09-28: no midnight-IST session split.)*
2. *(resolved 2026-09-28: one touchpoint per session; SPEC §9's collapse rule only matters across sessions, in the attribution engine.)*
3. *(resolved 2026-09-28: the payment-gateway ignore list is platform-maintained for MVP — `IGNORABLE_REFERRER_HOSTS` in `packages/shared/src/events.ts`.)*
4. *(resolved: `fbc` construction per Meta's documented server-side format.)*
5. *(resolved: `@clickhouse/client` approved; SPEC v0.2 §3.)*
6. **Consumer count.** Two consumers can process the same visitor concurrently, making sessions slightly imprecise (§4.2). If that matters in practice, shard the stream by visitor hash. That would change the canonical `stream:events-raw` name (an HLD §8 change) and is deferred.
