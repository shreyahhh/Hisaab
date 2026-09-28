import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { ch, type ClickHouseClient } from '@truepath/clickhouse';
import {
  createEventEffectsRepository,
  type ConsentChange,
  type ConsentRecordInput,
  type Db,
} from '@truepath/db';
import { storeContext, type IdentityHasher } from '@truepath/privacy';
import {
  CHECKOUT_KEY_TTL_SECONDS,
  DEDUPE_TTL_SECONDS,
  DSR_WITHDRAWAL_DELAY_MS,
  SUPPRESSION_TTL_DAYS,
  campaignFingerprint,
  checkoutKey,
  classify,
  dedupeKey,
  externalReferrerHost,
  normaliseOrderId,
  parseLanding,
  resolveFbc,
  sessionKey,
  storeBoundScope,
  type DsrJob,
  type Landing,
  type SessionAssignment,
  type StreamEventEntry,
  type StreamSuppressionHit,
} from '@truepath/shared';
import { assignSessions } from './sessionAssign.js';
import {
  SuppressionNotReadyError,
  checkSuppression,
  isSuppressionReady,
  queueSuppressionMirror,
  type SuppressionMirrorOp,
  type SuppressionProbe,
} from './eventSuppression.js';
import { parseStreamEntry, type RawStreamEntry } from './streamEntries.js';
import type { StoreContextSource } from './storeEventContext.js';

// One batch through the event pipeline (event-pipeline.md §4.1 steps 3–13). It takes raw stream
// entries and returns which of them may now be XACKed; reading, flushing, retrying and reclaiming are
// the consumer's job (eventConsumer.ts). Everything a shopper's data touches is checked again here at
// execution time (HLD §8: suppression re-checked by every worker), and nothing is acknowledged until
// ClickHouse, Postgres and Redis have all committed.

export interface EventBatchDeps {
  readonly redis: Redis;
  readonly clickhouse: ClickHouseClient;
  readonly db: Db;
  readonly hasher: IdentityHasher;
  readonly dsrQueue: Pick<Queue<DsrJob>, 'add'>;
  readonly stores: StoreContextSource;
  /** The suppression readiness marker; only tests override the default (`suppress:ready`). */
  readonly readyKey?: string;
  readonly now: () => Date;
  /** A fresh UUID v7 for a session that starts. */
  readonly newSessionId: () => string;
}

/**
 * Session assignments already made for this batch's events. The consumer keeps one per batch across
 * in-process retries: session state in Redis has advanced by then, so re-running the sessioniser would
 * give a re-tried event a different session than the ClickHouse rows it already wrote.
 */
export type SessionMemo = Map<string, SessionAssignment>;

export type DropReason =
  'suppressed_visitor' | 'suppressed_identity' | 'unknown_store' | 'duplicate';

export interface BatchResult {
  /** Entries fully handled (written, dropped or de-duplicated): safe to XACK. */
  readonly ackIds: readonly string[];
  readonly counts: {
    readonly received: number;
    /** Entries that failed validation. Not acked; the reclaimer dead-letters them after 5 deliveries. */
    readonly invalid: number;
    readonly written: number;
    readonly touchpoints: number;
    readonly dropped: Readonly<Record<DropReason, number>>;
    readonly suppressionHits: number;
    /** Suppression hits with no matching erased identity entry (possible across a key rotation). */
    readonly suppressionHitsUnmatched: number;
    readonly withdrawals: number;
    readonly ordersLinked: number;
  };
}

const CONSENT_EVENTS: ReadonlySet<string> = new Set(['consent_granted', 'consent_withdrawn']);
const IDENTITY_EVENTS: ReadonlySet<string> = new Set([
  'checkout_contact_info_submitted',
  'checkout_completed',
]);

interface EventItem {
  readonly id: string;
  readonly e: StreamEventEntry;
  readonly ms: number;
  readonly isConsent: boolean;
  readonly seq: number;
}

interface HitItem {
  readonly id: string;
  readonly storeId: string;
  readonly visitorId: string;
  readonly identityHash: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const EMPTY_LANDING: Landing = {
  utm_source: '',
  utm_medium: '',
  utm_campaign: '',
  utm_content: '',
  utm_term: '',
  fbclid: '',
  gclid: '',
  gbraid: '',
  wbraid: '',
  referrer_host: '',
};

function consentSource(e: StreamEventEntry): ConsentRecordInput['source'] {
  if (e.event_name === 'consent_granted') {
    if (e.consent_trigger === 'initial_state') return 'pixel_initial_state';
    if (e.consent_trigger === 'refresh') return 'pixel_refresh';
  }
  return 'pixel_interaction';
}

export async function processEventBatch(
  deps: EventBatchDeps,
  raw: readonly RawStreamEntry[],
  memo: SessionMemo = new Map(),
): Promise<BatchResult> {
  // Step 3: without the suppression sets we can't tell who has been erased — do nothing at all.
  if (!(await isSuppressionReady(deps.redis, deps.readyKey))) throw new SuppressionNotReadyError();

  const now = deps.now();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const ackIds: string[] = [];
  const dropped: Record<DropReason, number> = {
    suppressed_visitor: 0,
    suppressed_identity: 0,
    unknown_store: 0,
    duplicate: 0,
  };
  let invalid = 0;

  // --- parse -------------------------------------------------------------------------------------
  const eventsByStore = new Map<string, EventItem[]>();
  const hitsByStore = new Map<string, HitItem[]>();
  raw.forEach((r, seq) => {
    const parsed = parseStreamEntry(r);
    if (!parsed) {
      invalid += 1;
      return;
    }
    const { entry } = parsed;
    if (entry.kind === 'suppression_hit') {
      const hit: StreamSuppressionHit = entry;
      const list = hitsByStore.get(hit.store_id) ?? [];
      list.push({
        id: parsed.id,
        storeId: hit.store_id,
        visitorId: hit.visitor_id,
        identityHash: hit.identity_hash_hmac,
      });
      hitsByStore.set(hit.store_id, list);
      return;
    }
    const list = eventsByStore.get(entry.store_id) ?? [];
    list.push({
      id: parsed.id,
      e: entry,
      ms: Date.parse(entry.occurred_at),
      isConsent: CONSENT_EVENTS.has(entry.event_name),
      seq,
    });
    eventsByStore.set(entry.store_id, list);
  });

  // --- step 4: store context; entries of an unknown store are dropped ------------------------------
  const storeIds = [...new Set([...eventsByStore.keys(), ...hitsByStore.keys()])];
  const contexts = new Map<string, NonNullable<Awaited<ReturnType<StoreContextSource['get']>>>>();
  for (const storeId of storeIds) {
    const ctx = await deps.stores.get(storeId);
    if (ctx) {
      contexts.set(storeId, ctx);
      continue;
    }
    for (const item of eventsByStore.get(storeId) ?? []) {
      ackIds.push(item.id);
      dropped.unknown_store += 1;
    }
    for (const hit of hitsByStore.get(storeId) ?? []) ackIds.push(hit.id);
    eventsByStore.delete(storeId);
    hitsByStore.delete(storeId);
  }

  // --- step 5: suppression re-check (one round trip for the whole batch) ---------------------------
  const allEvents = [...eventsByStore.values()].flat();
  const probes: SuppressionProbe[] = allEvents.map((item) => {
    const { e } = item;
    const ctx = storeContext(e.store_id);
    const identityHashes = [
      ...new Set(
        [e.identity.phone_hmac, e.identity.email_hmac, e.identity.identity_hash_hmac].filter(
          (h): h is NonNullable<typeof h> => h !== undefined,
        ),
      ),
    ];
    return {
      storeId: e.store_id,
      visitorHmacs: deps.hasher.hmacAll(ctx, e.visitor_id),
      identityHashes,
      checkWithdrawn: !item.isConsent,
    };
  });
  const verdicts = await checkSuppression(deps.redis, probes, nowSeconds);

  // Visitors to erase because an erased identity showed up on them. A hit the Collector already
  // emitted counts too; here we also catch an erasure that landed after the Collector's check.
  const hitVisitors = new Set<string>(); // `${storeId}|${visitorId}`
  const hitKey = (storeId: string, visitorId: string): string => `${storeId}|${visitorId}`;
  for (const hits of hitsByStore.values()) {
    for (const hit of hits) hitVisitors.add(hitKey(hit.storeId, hit.visitorId));
  }
  const workerHits = new Map<string, HitItem>();
  const survivors: EventItem[] = [];
  allEvents.forEach((item, i) => {
    const verdict = verdicts[i];
    if (verdict === 'erased_visitor' || verdict === 'withdrawn') {
      dropped.suppressed_visitor += 1;
      ackIds.push(item.id);
    } else if (verdict === 'erased_identity') {
      dropped.suppressed_identity += 1;
      ackIds.push(item.id);
      const key = hitKey(item.e.store_id, item.e.visitor_id);
      hitVisitors.add(key);
      const identityHash =
        item.e.identity.identity_hash_hmac ??
        item.e.identity.phone_hmac ??
        item.e.identity.email_hmac;
      if (identityHash !== undefined && !workerHits.has(key)) {
        workerHits.set(key, {
          id: item.id,
          storeId: item.e.store_id,
          visitorId: item.e.visitor_id,
          identityHash,
        });
      }
    } else {
      survivors.push(item);
    }
  });
  // Nothing more of an erased visitor is stored, in this batch or otherwise.
  const afterHits = survivors.filter((item) => {
    if (!hitVisitors.has(hitKey(item.e.store_id, item.e.visitor_id))) return true;
    dropped.suppressed_identity += 1;
    ackIds.push(item.id);
    return false;
  });

  // --- step 6: dedupe (one MGET) --------------------------------------------------------------------
  const dedupeKeys = afterHits.map((item) =>
    dedupeKey(storeBoundScope(item.e.store_id), item.e.store_id, item.e.event_id),
  );
  const seen = dedupeKeys.length === 0 ? [] : await deps.redis.mget(...dedupeKeys);
  const fresh: EventItem[] = [];
  afterHits.forEach((item, i) => {
    if (seen[i] === 'done') {
      dropped.duplicate += 1;
      ackIds.push(item.id);
    } else {
      fresh.push(item);
    }
  });

  // A withdrawal in this very batch stops the visitor's later events too: they would be erased within
  // minutes anyway, and must not be stored in the meantime.
  const latestConsent = new Map<string, EventItem>();
  for (const item of [...fresh].filter((i) => i.isConsent).sort(byTime)) {
    latestConsent.set(hitKey(item.e.store_id, item.e.visitor_id), item);
  }
  const toWrite = fresh.filter((item) => {
    if (item.isConsent) return true;
    const last = latestConsent.get(hitKey(item.e.store_id, item.e.visitor_id));
    if (last?.e.event_name === 'consent_withdrawn' && item.ms > last.ms) {
      dropped.suppressed_visitor += 1;
      ackIds.push(item.id);
      return false;
    }
    return true;
  });

  // --- steps 7–9: enrich, sessionise, touchpoints ----------------------------------------------------
  const perStore = new Map<string, EventItem[]>();
  for (const item of toWrite) {
    const list = perStore.get(item.e.store_id) ?? [];
    list.push(item);
    perStore.set(item.e.store_id, list);
  }

  interface Enriched {
    readonly item: EventItem;
    readonly landing: Landing;
    readonly hosts: readonly string[];
  }
  const enriched = new Map<string, Enriched>();
  for (const item of toWrite) {
    const ctx = contexts.get(item.e.store_id)!;
    enriched.set(item.e.event_id, {
      item,
      // Consent events carry no landing semantics: their URL params are not a campaign touch.
      landing: item.isConsent ? EMPTY_LANDING : parseLanding(item.e.page_url, item.e.referrer),
      // The event's own page host is the shop's own host by construction (the Collector verifies it).
      hosts: [...ctx.shopHosts, hostOf(item.e.page_url)],
    });
  }

  // One atomic Lua call per visitor, in parallel.
  const byVisitor = new Map<string, EventItem[]>();
  for (const item of toWrite) {
    const key = hitKey(item.e.store_id, item.e.visitor_id);
    const list = byVisitor.get(key) ?? [];
    list.push(item);
    byVisitor.set(key, list);
  }
  await Promise.all(
    [...byVisitor.values()].map(async (items) => {
      const pending = items.filter((i) => !memo.has(i.e.event_id));
      if (pending.length === 0) return;
      const first = pending[0]!.e;
      const assignments = await assignSessions(
        deps.redis,
        sessionKey(storeBoundScope(first.store_id), first.store_id, first.visitor_id),
        pending.map((i) => {
          const en = enriched.get(i.e.event_id)!;
          return {
            occurred_at_ms: i.ms,
            campaign_fp: campaignFingerprint(en.landing),
            external_referrer_host: externalReferrerHost(en.landing, en.hosts),
            is_consent: i.isConsent,
            new_session_id: deps.newSessionId(),
          };
        }),
      );
      pending.forEach((i, n) => memo.set(i.e.event_id, assignments[n]!));
    }),
  );

  // --- step 10: ClickHouse, one insert per table per store, before anything is acknowledged -----------
  let touchpointCount = 0;
  for (const [storeId, items] of perStore) {
    const ctx = contexts.get(storeId)!;
    const scoped = ch(deps.clickhouse, storeBoundScope(storeId), storeId);
    const eventRows: Record<string, unknown>[] = [];
    const touchpointRows: Record<string, unknown>[] = [];
    const linkRows: Record<string, unknown>[] = [];

    for (const item of items) {
      const { e } = item;
      const en = enriched.get(e.event_id)!;
      const assignment = memo.get(e.event_id)!;
      // `fbc` only for a visitor consented to ad-platform measurement (the Collector strips the pixel's
      // own `fbc` without it; deriving one from the URL here must not sidestep that).
      const fbc = e.consent_purposes.includes('ad_platform_measurement')
        ? resolveFbc(e.fbc, en.landing, item.ms)
        : '';

      eventRows.push({
        store_id: e.store_id,
        event_id: e.event_id,
        event_name: e.event_name,
        occurred_at: e.occurred_at,
        received_at: e.received_at,
        visitor_id: e.visitor_id,
        session_id: assignment.session_id,
        page_url: e.page_url,
        referrer: e.referrer,
        utm_source: en.landing.utm_source,
        utm_medium: en.landing.utm_medium,
        utm_campaign: en.landing.utm_campaign,
        utm_content: en.landing.utm_content,
        utm_term: en.landing.utm_term,
        fbclid: en.landing.fbclid,
        gclid: en.landing.gclid,
        gbraid: en.landing.gbraid,
        wbraid: en.landing.wbraid,
        fbp: e.fbp ?? '',
        fbc,
        device_type: e.device_type,
        os: e.os,
        browser: e.browser,
        is_in_app_browser: e.is_in_app_browser,
        geo_state: e.geo_state,
        geo_city: e.geo_city,
        consent_purposes: e.consent_purposes,
        identity_hash_hmac: e.identity.identity_hash_hmac ?? '',
        properties: JSON.stringify(e.properties),
      });

      if (assignment.started && !item.isConsent) {
        const c = classify(en.landing, ctx.rules, { shopHosts: en.hosts });
        touchpointRows.push({
          store_id: e.store_id,
          visitor_id: e.visitor_id,
          session_id: assignment.session_id,
          occurred_at: e.occurred_at,
          channel: c.channel,
          sub_channel: c.sub_channel,
          platform: c.platform ?? '',
          campaign_id: c.campaign_id,
          adset_id: c.adset_id,
          ad_id: c.ad_id,
          click_id_type: c.click_id_type,
          is_direct: c.is_direct,
          event_id: e.event_id,
        });
      }

      if (IDENTITY_EVENTS.has(e.event_name)) {
        for (const hash of new Set(
          [e.identity.phone_hmac, e.identity.email_hmac].filter((h) => h !== undefined),
        )) {
          linkRows.push({
            store_id: e.store_id,
            visitor_id: e.visitor_id,
            identity_hash_hmac: hash,
            first_seen: e.occurred_at,
            last_seen: e.occurred_at,
          });
        }
      }
    }

    await scoped.insert('events', eventRows);
    await scoped.insert('touchpoints', touchpointRows);
    await scoped.insert('identity_links', linkRows);
    touchpointCount += touchpointRows.length;
  }

  // --- step 11: Postgres, one transaction per store ---------------------------------------------------
  const suppressionExpiresAt = new Date(now.getTime() + SUPPRESSION_TTL_DAYS * 86_400_000);
  const withdrawalDueAt = new Date(now.getTime() + 86_400_000);
  const effects = createEventEffectsRepository(deps.db);
  const mirror: SuppressionMirrorOp[] = [];
  const jobs: { name: string; data: DsrJob; opts: { jobId: string; delay?: number } }[] = [];
  let withdrawals = 0;
  let hitsHandled = 0;
  let hitsUnmatched = 0;
  let ordersLinked = 0;
  const checkoutWrites: { storeId: string; orderId: string; visitorId: string }[] = [];

  const storesWithEffects = new Set([
    ...perStore.keys(),
    ...hitsByStore.keys(),
    ...[...workerHits.values()].map((h) => h.storeId),
  ]);
  for (const storeId of storesWithEffects) {
    const items = (perStore.get(storeId) ?? []).slice().sort(byTime);
    const hasher = deps.hasher;
    const hctx = storeContext(storeId);

    const consentRecords: ConsentRecordInput[] = [];
    const consentChanges: ConsentChange[] = [];
    const checkoutLinks: { externalOrderId: string; visitorId: string }[] = [];
    for (const item of items) {
      const { e } = item;
      if (item.isConsent) {
        const granted = e.event_name === 'consent_granted';
        consentRecords.push({
          id: e.event_id,
          visitorHmac: hasher.hmac(hctx, e.visitor_id),
          purposes: e.consent_purposes,
          state: granted ? 'granted' : 'withdrawn',
          noticeVersion: e.notice_version ?? 'unknown',
          source: consentSource(e),
          occurredAt: new Date(item.ms),
        });
        if (!granted) {
          consentChanges.push({
            kind: 'withdraw',
            eventId: e.event_id,
            visitorHmac: hasher.hmac(hctx, e.visitor_id),
          });
        } else if (e.consent_purposes.includes('attribution_analytics')) {
          // A grant without analytics (marketing only) doesn't bring a withdrawn visitor back.
          consentChanges.push({ kind: 'grant', visitorHmacs: hasher.hmacAll(hctx, e.visitor_id) });
        }
      } else if (e.event_name === 'checkout_completed') {
        // Shopify doesn't document the format of the pixel's order id: accept a GID or a number and
        // store the numeric id `orders.external_order_id` holds (identity-stitching.md §4.1 step 2).
        const rawOrderId = e.properties['order_id'];
        const orderId = typeof rawOrderId === 'string' ? normaliseOrderId(rawOrderId) : null;
        if (orderId !== null) {
          checkoutLinks.push({ externalOrderId: orderId, visitorId: e.visitor_id });
          checkoutWrites.push({ storeId, orderId, visitorId: e.visitor_id });
        }
      }
    }

    // Suppression hits: the Collector's, plus any the re-check found. One per visitor.
    const hits = new Map<string, HitItem>();
    for (const hit of hitsByStore.get(storeId) ?? []) hits.set(hit.visitorId, hit);
    for (const hit of workerHits.values()) {
      if (hit.storeId === storeId && !hits.has(hit.visitorId)) hits.set(hit.visitorId, hit);
    }
    const hitList = [...hits.values()];

    const result = await effects.applyStoreEffects(storeBoundScope(storeId), {
      storeId,
      now,
      consentRecords,
      consentChanges,
      suppressionHits: hitList.map((h) => ({
        visitorHmac: hasher.hmac(hctx, h.visitorId),
        identityHash: h.identityHash,
      })),
      checkoutLinks,
      suppressionExpiresAt,
      withdrawalDueAt,
    });
    ordersLinked += result.ordersLinked;

    // Redis mirror of what Postgres just committed, in event order.
    const expiresAtSeconds = Math.floor(suppressionExpiresAt.getTime() / 1000);
    for (const change of consentChanges) {
      if (change.kind === 'withdraw') {
        mirror.push({
          op: 'add',
          storeId,
          kind: 'withdrawn:visitor',
          member: change.visitorHmac,
          expiresAtSeconds,
        });
      } else {
        mirror.push({
          op: 'remove',
          storeId,
          kind: 'withdrawn:visitor',
          members: change.visitorHmacs,
        });
      }
    }
    for (const request of result.withdrawalRequests) {
      withdrawals += 1;
      jobs.push({
        name: 'erasure',
        data: { storeId, type: 'erasure', requestId: request.requestId },
        opts: { jobId: `dsr-${request.requestId}`, delay: DSR_WITHDRAWAL_DELAY_MS },
      });
    }
    result.suppressionHitRequests.forEach((hit, n) => {
      hitsHandled += 1;
      mirror.push({
        op: 'add',
        storeId,
        kind: 'erased:visitor',
        member: hit.visitorHmac,
        expiresAtSeconds,
      });
      if (hit.requestId === null) {
        hitsUnmatched += 1;
        return;
      }
      jobs.push({
        name: 'erasure',
        data: {
          storeId,
          type: 'erasure',
          requestId: hit.requestId,
          visitorIds: [hitList[n]!.visitorId],
        },
        // BullMQ rejects ':' in custom ids (and the visitor's HMAC must not end up in a logged id).
        opts: { jobId: `dsr-followup-${hit.requestId}-${hit.suppressionId}` },
      });
    });
  }

  // --- step 13 (moved before 12): jobs. A failed enqueue aborts the batch, and the job ids de-duplicate
  // its retry. They go BEFORE the dedupe keys are written: with the keys first, a retry would find a
  // withdrawal's consent event already 'done', skip it, and its erasure job would never be enqueued.
  for (const job of jobs) await deps.dsrQueue.add(job.name, job.data, job.opts);

  // --- step 12: Redis writes (only after ClickHouse, Postgres and the jobs are in) -------------------
  const pipeline = deps.redis.pipeline();
  queueSuppressionMirror(pipeline, mirror);
  for (const c of checkoutWrites) {
    pipeline.set(
      checkoutKey(storeBoundScope(c.storeId), c.storeId, c.orderId),
      c.visitorId,
      'EX',
      CHECKOUT_KEY_TTL_SECONDS,
    );
  }
  for (const item of toWrite) {
    pipeline.set(
      dedupeKey(storeBoundScope(item.e.store_id), item.e.store_id, item.e.event_id),
      'done',
      'EX',
      DEDUPE_TTL_SECONDS,
    );
  }
  for (const [error] of (await pipeline.exec()) ?? []) if (error) throw error;

  for (const item of toWrite) ackIds.push(item.id);
  for (const hits of hitsByStore.values()) for (const hit of hits) ackIds.push(hit.id);

  return {
    ackIds,
    counts: {
      received: raw.length,
      invalid,
      written: toWrite.length,
      touchpoints: touchpointCount,
      dropped,
      suppressionHits: hitsHandled,
      suppressionHitsUnmatched: hitsUnmatched,
      withdrawals,
      ordersLinked,
    },
  };
}

function byTime(a: EventItem, b: EventItem): number {
  return a.ms - b.ms || a.seq - b.seq;
}
