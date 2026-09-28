import type { Redis } from 'ioredis';
import {
  asStoreId,
  hashContact,
  sanitiseReferrer,
  sanitiseUrl,
  storeContext,
  type ConsentProvider,
  type IdentityHasher,
} from '@truepath/privacy';
import {
  COLLECTOR_STATS_TTL_SECONDS,
  CollectBatch,
  STREAM_EVENTS_RAW,
  STREAM_EVENTS_RAW_MAXLEN,
  SUPPRESSION_TTL_DAYS,
  SUPPRESS_READY_KEY,
  statsCollectorKey,
  storeBoundScope,
  suppressionSetKey,
  type CollectorDropReason,
  type CollectorStoreConfig,
  type PixelEvent,
  type StreamEventEntry,
} from '@truepath/shared';
import type { GeoLookup } from './geo.js';
import { runIngest, type IngestEvent, type IngestKeys } from './ingest.js';
import {
  applyClockRules,
  flattenProperties,
  istDay,
  pageHostAllowed,
  parseUserAgent,
} from './minimise.js';
import type { TokenBucketLimiter } from './rateLimit.js';
import { verifySignature } from './signature.js';
import type { StoreConfigCache } from './storeConfig.js';

// One `POST /v1/collect` request, from the raw inputs to a status (collector.md §4). A plain function
// of its dependencies so it is testable without HTTP; `app.ts` only adapts Fastify to it.
//
// The order is the LLD's and is deliberate: cheap checks that need no store knowledge first, the
// signature before any parsing of the body, and consent/suppression before anything is hashed or
// stored. No shopper identifier, the query string, the body, the IP or the user agent ever appears in
// the result or in a log line (§6).

export type CollectErrorCode =
  | 'invalid_payload'
  | 'unknown_store_key'
  | 'invalid_signature'
  | 'stale_signature'
  | 'origin_not_allowed'
  | 'rate_limited'
  | 'suppression_unavailable'
  | 'stream_unavailable';

export interface CollectResult {
  readonly status: 204 | 400 | 401 | 403 | 429 | 503;
  readonly error?: CollectErrorCode;
  /** Present once the store is known — safe to log (`store_id` is not a shopper identifier). */
  readonly storeId?: string;
  readonly accepted: number;
  /** Reason → count; reasons only, never identifiers. */
  readonly dropped: Readonly<Record<string, number>>;
}

export interface CollectDeps {
  readonly redis: Pick<Redis, 'get' | 'evalsha' | 'eval'>;
  readonly storeConfigs: StoreConfigCache;
  readonly hasher: IdentityHasher;
  readonly consent: ConsentProvider;
  readonly geo: GeoLookup;
  readonly ipLimiter: TokenBucketLimiter;
  readonly storeLimiter: TokenBucketLimiter;
  readonly now: () => number;
  /**
   * Test seam for the two GLOBAL Redis names (`suppress:ready`, `stream:events-raw`). Production never
   * sets it, so it always uses the canonical HLD §8 names; tests point it at isolated keys so they
   * can't write to (or delete the readiness marker of) a developer's real local pipeline.
   */
  readonly redisKeys?: { readonly ready?: string; readonly stream?: string };
}

function ingestKeys(deps: CollectDeps, storeId: string, nowMs: number): IngestKeys {
  const scope = storeBoundScope(storeId);
  return {
    ready: deps.redisKeys?.ready ?? SUPPRESS_READY_KEY,
    stream: deps.redisKeys?.stream ?? STREAM_EVENTS_RAW,
    erasedVisitor: suppressionSetKey(scope, storeId, 'erased:visitor'),
    withdrawnVisitor: suppressionSetKey(scope, storeId, 'withdrawn:visitor'),
    erasedIdentity: suppressionSetKey(scope, storeId, 'erased:identity'),
    stats: statsCollectorKey(scope, storeId, istDay(nowMs)),
  };
}

export interface CollectRequest {
  readonly query: {
    readonly k?: string;
    readonly ts?: string;
    readonly kid?: string;
    readonly sig?: string;
  };
  readonly rawBody: string;
  readonly origin: string | undefined;
  /** The client IP — used for the rate limit and the geo lookup, then dropped; never stored or logged. */
  readonly ip: string;
  /** Parsed to device/browser/OS and dropped (SPEC v0.5). */
  readonly userAgent: string | undefined;
}

const fail = (
  status: CollectResult['status'],
  error: CollectErrorCode,
  storeId?: string,
): CollectResult => ({
  status,
  error,
  ...(storeId ? { storeId } : {}),
  accepted: 0,
  dropped: {},
});

const IS_CONSENT_EVENT = (event: PixelEvent): boolean =>
  event.event_name === 'consent_granted' || event.event_name === 'consent_withdrawn';

export async function handleCollect(
  deps: CollectDeps,
  req: CollectRequest,
): Promise<CollectResult> {
  const nowMs = deps.now();

  // Per-IP limit first: it needs nothing from the request, so it is the cheapest way to shed a flood.
  // (LLD step 5 sits after the signature; doing it earlier only makes a flood cheaper to refuse.)
  if (!deps.ipLimiter.tryTake(req.ip)) return fail(429, 'rate_limited');

  // 2. Store config.
  const storeKey = req.query.k;
  let config: CollectorStoreConfig | null;
  try {
    config = storeKey ? await deps.storeConfigs.get(storeKey) : null;
  } catch {
    return fail(503, 'stream_unavailable');
  }
  if (!config) return fail(401, 'unknown_store_key');
  const storeId = config.storeId;

  // 3. Signature — over the raw body, before it is parsed.
  const signature = verifySignature(config, req.query, req.rawBody, nowMs);
  if (!signature.ok) return fail(401, signature.reason, storeId);

  // 4. Origin. The strict pixel sandbox sends `Origin: null`, so a missing or null origin passes and
  // the per-event page-host check below carries the weight (collector.md §4 step 4).
  if (req.origin && req.origin !== 'null' && !config.allowedOrigins.includes(req.origin)) {
    return fail(403, 'origin_not_allowed', storeId);
  }

  // 6. Validate.
  let json: unknown;
  try {
    json = JSON.parse(req.rawBody);
  } catch {
    return fail(400, 'invalid_payload', storeId);
  }
  const parsed = CollectBatch.safeParse(json);
  if (!parsed.success) return fail(400, 'invalid_payload', storeId);
  const batch = parsed.data;

  // Per-store limit, by event count (known only now).
  if (!deps.storeLimiter.tryTake(storeId, batch.events.length))
    return fail(429, 'rate_limited', storeId);

  const preDrops: Partial<Record<CollectorDropReason, number>> = {};
  const drop = (reason: CollectorDropReason, n = 1): void => {
    preDrops[reason] = (preDrops[reason] ?? 0) + n;
  };

  // 7. An inactive store drops everything before any processing.
  if (config.status === 'inactive') {
    drop('store_inactive', batch.events.length);
    return countOnly(deps, storeId, nowMs, preDrops);
  }

  // Consent for this batch.
  const decision = deps.consent.evaluate(
    {
      source: 'shopify_customer_privacy',
      analytics: batch.consent.analytics,
      marketing: batch.consent.marketing,
      noticeVersion: batch.consent.notice_version,
    },
    { childDirected: config.childDirected },
  );

  // Everything below is per store; none of it sees another tenant's data (SPEC §7.3 rule 5).
  const ua = parseUserAgent(req.userAgent);
  const geo = deps.geo.lookup(req.ip);
  const hashStoreId = asStoreId(storeId);
  const hashCtx = storeContext(hashStoreId);
  const receivedAt = new Date(nowMs).toISOString();

  const ingestEvents: IngestEvent[] = [];
  for (const event of batch.events) {
    const consentEvent = IS_CONSENT_EVENT(event);

    // No analytics consent → only the consent events themselves are forwarded.
    if (!consentEvent && !decision.canStore) {
      drop('no_analytics_consent');
      continue;
    }

    const clock = applyClockRules(event.occurred_at, nowMs);
    if (clock.kind === 'stale') {
      drop('stale_event');
      continue;
    }

    const pageUrl = sanitiseUrl(event.page_url);
    if (pageUrl === '' || !pageHostAllowed(event.page_url, config.allowedOrigins)) {
      drop('foreign_page');
      continue;
    }

    // Hash phone/email only now, for events that will actually be stored (8). The raw values exist
    // only inside this call and are never logged.
    const contact = 'contact' in event ? event.contact : undefined;
    const hashed = contact ? hashContact(deps.hasher, hashStoreId, contact) : undefined;
    const identity = {
      ...(hashed?.phoneHmac ? { phone_hmac: hashed.phoneHmac } : {}),
      ...(hashed?.emailHmac ? { email_hmac: hashed.emailHmac } : {}),
      ...(hashed?.identityHashHmac ? { identity_hash_hmac: hashed.identityHashHmac } : {}),
    };

    const entry: StreamEventEntry = {
      kind: 'event',
      store_id: storeId,
      event_id: event.event_id,
      event_name: event.event_name,
      occurred_at: clock.occurredAt,
      received_at: receivedAt,
      visitor_id: batch.visitor_id,
      visitor_new: batch.visitor_new,
      ...(event.event_name === 'consent_granted' ? { consent_trigger: event.trigger } : {}),
      page_url: pageUrl,
      referrer: sanitiseReferrer(event.referrer),
      // fbp/fbc only with marketing consent, and never for a child-directed store (P-6) — enforced
      // here as well as in the pixel, because the pixel is not a trusted party.
      ...(decision.canSendToAdPlatforms && batch.click?.fbp ? { fbp: batch.click.fbp } : {}),
      ...(decision.canSendToAdPlatforms && batch.click?.fbc ? { fbc: batch.click.fbc } : {}),
      device_type: ua.device_type,
      os: ua.os,
      browser: ua.browser,
      is_in_app_browser: ua.is_in_app_browser,
      geo_state: geo.state,
      geo_city: geo.city,
      consent_purposes: [...decision.purposes],
      identity,
      properties: flattenProperties(event),
    };
    ingestEvents.push({
      payload: JSON.stringify(entry),
      isConsent: consentEvent,
      identityLookup: hashed?.lookup ?? [],
      ...(hashed?.identityHashHmac ? { identityHash: hashed.identityHashHmac } : {}),
    });
  }

  // 10. Suppression + append in one round trip.
  let result;
  try {
    result = await runIngest(deps.redis, ingestKeys(deps, storeId, nowMs), {
      nowSeconds: Math.floor(nowMs / 1000),
      maxlen: STREAM_EVENTS_RAW_MAXLEN,
      statsTtl: COLLECTOR_STATS_TTL_SECONDS,
      suppressTtl: SUPPRESSION_TTL_DAYS * 24 * 60 * 60,
      storeId,
      visitorId: batch.visitor_id,
      receivedAt,
      visitorHmacs: deps.hasher.hmacAll(hashCtx, batch.visitor_id),
      visitorHmacWrite: deps.hasher.hmac(hashCtx, batch.visitor_id),
      preDrops,
      events: ingestEvents,
    });
  } catch {
    return fail(503, 'stream_unavailable', storeId);
  }
  if (result.status === 'not_ready') return fail(503, 'suppression_unavailable', storeId);

  // 11. A drop is never an error: the response does not reveal consent or suppression state.
  return {
    status: 204,
    storeId,
    accepted: result.accepted,
    // The script counts the drops it was handed (`preDrops`) together with its own.
    dropped: { ...result.drops },
  };
}

/**
 * A batch dropped wholesale before any per-event work (inactive store): the counters are still
 * written, through the same script so the readiness rule applies (an unready suppression set means
 * 503 here too — a store going inactive must not mask the fail-closed behaviour).
 */
async function countOnly(
  deps: CollectDeps,
  storeId: string,
  nowMs: number,
  preDrops: Partial<Record<CollectorDropReason, number>>,
): Promise<CollectResult> {
  try {
    const result = await runIngest(deps.redis, ingestKeys(deps, storeId, nowMs), {
      nowSeconds: Math.floor(nowMs / 1000),
      maxlen: STREAM_EVENTS_RAW_MAXLEN,
      statsTtl: COLLECTOR_STATS_TTL_SECONDS,
      suppressTtl: SUPPRESSION_TTL_DAYS * 24 * 60 * 60,
      storeId,
      visitorId: '',
      receivedAt: new Date(nowMs).toISOString(),
      visitorHmacs: [],
      visitorHmacWrite: '',
      preDrops,
      events: [],
    });
    if (result.status === 'not_ready') return fail(503, 'suppression_unavailable', storeId);
    return { status: 204, storeId, accepted: 0, dropped: { ...result.drops } };
  } catch {
    return fail(503, 'stream_unavailable', storeId);
  }
}
