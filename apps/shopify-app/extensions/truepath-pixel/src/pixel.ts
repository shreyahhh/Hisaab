import {
  consentEvent,
  mapStandardEvent,
  STANDARD_EVENT_NAMES,
  type MappedEvent,
} from './mapping.js';
import type { PixelApi, PixelDeps } from './types.js';
import { UUID_V7_PATTERN, uuidV7 } from './uuid.js';

// The TruePath Web Pixel's logic (SPEC §7.1, collector.md §2.2, shopify-integration.md §2.2), written
// against `PixelApi`/`PixelDeps` so it runs unchanged in the strict sandbox and under test.
//
// What it guarantees, in priority order:
//  1. Consent first (P-1, P-3). Nothing but a `consent_withdrawn` is ever sent while analytics
//     processing is not allowed; a withdrawal drops everything still buffered and is sent at once.
//  2. Minimal, contract-shaped output. Events are mapped to the Collector's strict schema; anything
//     that wouldn't fit is dropped here, never sent. It stores one visitor id and one consent record
//     in the sandbox's storage and nothing else.
//  3. Never disturb the page. Every error is swallowed; a failed send is not retried (LLD: the
//     Collector's 5xx responses are not retried either, so a retry queue would only add PII-at-rest
//     surface in the shopper's browser for no guarantee).

// Pinned to `packages/shared/src/collector.ts` by pixel.contract.test.ts — this file may not import
// runtime values from there (it is bundled for a browser).
export const COLLECT_MAX_BODY_BYTES = 10_240;
export const COLLECT_MAX_EVENTS_PER_BATCH = 25;
export const CONSENT_REFRESH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

export const VISITOR_STORAGE_KEY = 'tp_vid';
export const CONSENT_STORAGE_KEY = 'tp_consent';
const FLUSH_DELAY_MS = 2_000;
/** A page that emits events faster than they can be sent must not grow memory without bound. */
const MAX_BUFFERED_EVENTS = 200;
const MAX_NOTICE_VERSION = 32;

interface PixelConfig {
  readonly storeKey: string;
  readonly collectorUrl: string;
  readonly signingKid: string;
  readonly signingSecret: string;
  readonly noticeVersion: string;
}

interface ConsentRecord {
  readonly at: number;
  readonly analytics: boolean;
  readonly marketing: boolean;
}

type Trigger = 'interaction' | 'initial_state' | 'refresh';

export interface Pixel {
  /** Sends everything buffered now. Resolves once the request has been handed to the network. */
  flush(): Promise<void>;
}

/** https only — except localhost, so a developer can point the pixel at a Collector on their machine. */
function isAllowedCollectorUrl(url: string): boolean {
  return (
    url.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/|$)/.test(url)
  );
}

function readConfig(api: PixelApi): PixelConfig | null {
  const s = api.settings;
  if (
    !s.storeKey ||
    !s.collectorUrl ||
    !s.signingKid ||
    !s.signingSecret ||
    !s.noticeVersion ||
    s.noticeVersion.length > MAX_NOTICE_VERSION ||
    !isAllowedCollectorUrl(s.collectorUrl)
  ) {
    // Misconfigured install: do nothing at all rather than send somewhere unintended.
    return null;
  }
  return {
    storeKey: s.storeKey,
    collectorUrl: s.collectorUrl.replace(/\/+$/, ''),
    signingKid: s.signingKid,
    signingSecret: s.signingSecret,
    noticeVersion: s.noticeVersion,
  };
}

function parseConsentRecord(raw: string | null | undefined): ConsentRecord | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { at, analytics, marketing } = value as Record<string, unknown>;
    if (
      typeof at !== 'number' ||
      typeof analytics !== 'boolean' ||
      typeof marketing !== 'boolean'
    ) {
      return null;
    }
    return { at, analytics, marketing };
  } catch {
    return null;
  }
}

function pageOf(api: PixelApi, event?: unknown): { url: string; referrer: string } {
  const fromEvent = (
    event as
      { context?: { document?: { location?: { href?: unknown }; referrer?: unknown } } } | undefined
  )?.context?.document;
  const fromInit = api.init.context?.document;
  const href = fromEvent?.location?.href ?? fromInit?.location?.href;
  const referrer = fromEvent?.referrer ?? fromInit?.referrer;
  return {
    url: typeof href === 'string' ? href : '',
    referrer: typeof referrer === 'string' ? referrer : '',
  };
}

export async function startPixel(api: PixelApi, deps: PixelDeps): Promise<Pixel | null> {
  const config = readConfig(api);
  if (config === null) return null;

  const newEventId = (): string => uuidV7(deps.now(), deps.randomBytes());

  // Consent state as Shopify reports it right now.
  const initial = api.init.customerPrivacy;
  const consent = {
    analytics: initial?.analyticsProcessingAllowed === true,
    marketing: initial?.marketingAllowed === true,
  };

  // --- visitor id: one per browser, created on first sight -----------------------------------------
  let visitorId = '';
  let visitorIsNew = false;
  try {
    const stored = await api.browser.localStorage.getItem(VISITOR_STORAGE_KEY);
    if (stored && UUID_V7_PATTERN.test(stored)) visitorId = stored;
  } catch {
    // storage unavailable — fall through to a per-load id
  }
  if (visitorId === '') {
    visitorId = uuidV7(deps.now(), deps.randomBytes());
    visitorIsNew = true;
    try {
      await api.browser.localStorage.setItem(VISITOR_STORAGE_KEY, visitorId);
    } catch {
      // Not persisted: this load is a new visitor again next time. Accepted; nothing else to do.
    }
  }

  let record: ConsentRecord | null = null;
  try {
    record = parseConsentRecord(await api.browser.localStorage.getItem(CONSENT_STORAGE_KEY));
  } catch {
    record = null;
  }

  const saveRecord = async (): Promise<void> => {
    record = { at: deps.now(), analytics: consent.analytics, marketing: consent.marketing };
    try {
      await api.browser.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(record));
    } catch {
      // best effort
    }
  };

  // --- buffering and sending ----------------------------------------------------------------------
  let buffer: MappedEvent[] = [];
  let cancelTimer: (() => void) | null = null;
  let firstBatchPending = visitorIsNew;
  let sending: Promise<void> = Promise.resolve();

  const buildBody = async (events: MappedEvent[]): Promise<string> => {
    let click: { fbp?: string; fbc?: string } | undefined;
    if (consent.marketing) {
      // fbp/fbc only with marketing consent (collector.md §2.2). Read per batch: the cookie can appear
      // after load, once Meta's own pixel has run.
      const [fbp, fbc] = await Promise.all([
        api.browser.cookie.get('_fbp').catch(() => undefined),
        api.browser.cookie.get('_fbc').catch(() => undefined),
      ]);
      const picked = {
        ...(fbp && fbp.length <= 128 ? { fbp } : {}),
        ...(fbc && fbc.length <= 256 ? { fbc } : {}),
      };
      if (Object.keys(picked).length > 0) click = picked;
    }
    return JSON.stringify({
      v: 1,
      visitor_id: visitorId,
      visitor_new: firstBatchPending,
      sent_at: new Date(deps.now()).toISOString(),
      consent: {
        analytics: consent.analytics,
        marketing: consent.marketing,
        notice_version: config.noticeVersion,
      },
      ...(click ? { click } : {}),
      events,
    });
  };

  const post = async (body: string): Promise<void> => {
    const ts = Math.floor(deps.now() / 1000);
    const sig = await deps.hmacSha256Hex(config.signingSecret, `${ts}.${body}`);
    const query = new URLSearchParams({
      k: config.storeKey,
      ts: String(ts),
      kid: config.signingKid,
      sig,
    });
    await deps.post(`${config.collectorUrl}/v1/collect?${query.toString()}`, body);
  };

  const sendAll = async (): Promise<void> => {
    try {
      await sendPending();
    } catch {
      // Signing or serialising failed — drop, and never let it surface as an unhandled rejection.
    }
  };

  const sendPending = async (): Promise<void> => {
    let pending = buffer;
    buffer = [];
    while (pending.length > 0) {
      let take = Math.min(pending.length, COLLECT_MAX_EVENTS_PER_BATCH);
      let body = await buildBody(pending.slice(0, take));
      // Shrink until it fits the body limit; a single event that cannot fit is dropped (it can never
      // be sent), which the strict Collector would reject wholesale anyway.
      while (deps.byteLength(body) > COLLECT_MAX_BODY_BYTES && take > 1) {
        take = Math.ceil(take / 2);
        body = await buildBody(pending.slice(0, take));
      }
      pending = pending.slice(take);
      if (deps.byteLength(body) > COLLECT_MAX_BODY_BYTES) continue;
      try {
        await post(body);
      } catch {
        // Not retried (see the header). The batch is gone.
      }
      firstBatchPending = false;
    }
  };

  const flush = (): Promise<void> => {
    if (cancelTimer) {
      cancelTimer();
      cancelTimer = null;
    }
    // Serialised, so two flushes can never interleave and both claim `visitor_new`.
    sending = sending.then(sendAll, sendAll);
    return sending;
  };

  const enqueue = (event: MappedEvent | null): void => {
    if (event === null) return;
    // The consent gate: only a withdrawal may leave while analytics is not allowed.
    if (!consent.analytics && event.event_name !== 'consent_withdrawn') return;
    if (buffer.length >= MAX_BUFFERED_EVENTS) buffer.shift();
    buffer.push(event);
    if (buffer.length >= COLLECT_MAX_EVENTS_PER_BATCH) {
      void flush();
    } else if (cancelTimer === null) {
      cancelTimer = deps.schedule(() => {
        cancelTimer = null;
        void flush();
      }, FLUSH_DELAY_MS);
    }
  };

  const granted = (trigger: Trigger, event?: unknown): MappedEvent | null => {
    const page = pageOf(api, event);
    return consentEvent('consent_granted', page, deps.now(), newEventId, trigger);
  };
  const withdrawn = (event?: unknown): MappedEvent | null =>
    consentEvent('consent_withdrawn', pageOf(api, event), deps.now(), newEventId);

  // --- consent at load -----------------------------------------------------------------------------
  if (consent.analytics) {
    // A first sight, or consent that changed while we weren't watching, is `initial_state`; a
    // still-granted consent older than 30 days is re-asserted as `refresh` (SPEC v0.6 §7.1). Anything
    // else needs no event — the last one on record is still true.
    let trigger: Trigger | null = null;
    if (visitorIsNew || record === null || !record.analytics) trigger = 'initial_state';
    else if (record.marketing !== consent.marketing) trigger = 'refresh';
    else if (deps.now() - record.at > CONSENT_REFRESH_INTERVAL_MS) trigger = 'refresh';
    if (trigger !== null) {
      enqueue(granted(trigger));
      await saveRecord();
    }
  } else if (record?.analytics === true) {
    // Loaded although analytics is no longer allowed, and we last recorded it as granted: say so.
    enqueue(withdrawn());
    await saveRecord();
    void flush();
  }

  // --- subscriptions ------------------------------------------------------------------------------
  for (const name of STANDARD_EVENT_NAMES) {
    api.analytics.subscribe(name, (event) => {
      try {
        enqueue(mapStandardEvent(name, event, deps.now(), newEventId));
        // The order confirmation is the one event that must not wait: the page may unload right after.
        if (name === 'checkout_completed') void flush();
      } catch {
        // never let a mapping bug reach the storefront
      }
    });
  }

  api.analytics.subscribe('visitorConsentCollected', (event) => {
    void (async () => {
      try {
        const next = (event as { customerPrivacy?: unknown } | null)?.customerPrivacy;
        if (typeof next !== 'object' || next === null) return;
        const { analyticsProcessingAllowed, marketingAllowed } = next as Record<string, unknown>;
        consent.analytics = analyticsProcessingAllowed === true;
        consent.marketing = marketingAllowed === true;

        if (consent.analytics) {
          // Every interaction is reported, even one that leaves the values unchanged: the default-on
          // signal (P-1) needs to know a shopper actually used the banner.
          enqueue(granted('interaction', event));
        } else {
          // Withdrawal (P-3): nothing already buffered may be sent, and the withdrawal goes out now.
          buffer = [];
          enqueue(withdrawn(event));
          void flush();
        }
        await saveRecord();
      } catch {
        // swallow — see the header
      }
    })();
  });

  return { flush };
}
