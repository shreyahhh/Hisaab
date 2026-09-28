import { z } from 'zod';
import { CONSENT_PURPOSES, PIXEL_EVENT_NAMES } from './collector.js';

// The Collector → event-workers contract (collector.md §2.4, event-pipeline.md §2.1) and the Redis
// names around it (HLD §8 — canonical; nothing here is invented, and the list below is the whole set
// the Collector touches).

/** HLD §8: the stream the Collector appends to and `event-workers` consumes (group `event-workers`). */
export const STREAM_EVENTS_RAW = 'stream:events-raw';
/** HLD §8: poison entries (delivered ≥ 5 times). */
export const STREAM_EVENTS_DEAD = 'stream:events-dead';
export const EVENT_WORKERS_GROUP = 'event-workers';
/** collector.md §3: approximate trim length. Trimming past unprocessed entries is data loss (alerted on). */
export const STREAM_EVENTS_RAW_MAXLEN = 2_000_000;

/** HLD §8: written only after a full suppression rebuild; its absence makes the Collector fail closed. */
export const SUPPRESS_READY_KEY = 'suppress:ready';

// Key builders (`suppress:<store_id>:<kind>`, `stats:collector:<store_id>:<yyyymmdd>`, `dedupe:…`) are in
// keys.ts — they take a Scope, per ADR-0016.
export const COLLECTOR_STATS_TTL_SECONDS = 100 * 24 * 60 * 60;

/** Why the Collector deliberately dropped something (collector.md §4 step 10). Counted, never stored. */
export const COLLECTOR_DROP_REASONS = [
  'no_analytics_consent',
  'suppressed_visitor',
  'suppressed_identity',
  'store_inactive',
  'stale_event',
  'foreign_page',
] as const;
export type CollectorDropReason = (typeof COLLECTOR_DROP_REASONS)[number];

/** Default-on-region signal counters, incremented by `event-workers` (HLD §8). */
export const DEFAULT_ON_STATS_FIELDS = ['new_visitors', 'new_visitors_initial_only'] as const;

/** Suppression entries live this long (SPEC §5.7 / HLD §8: ≈ 13 months). */
export const SUPPRESSION_TTL_DAYS = 13 * 30;

// `k<N>:<64 hex>` — every stored HMAC (HLD §8). Repeated here (not imported from privacy) because
// this package sits below it.
const VersionedHmacString = z.string().regex(/^k\d+:[0-9a-f]{64}$/);

// Flattened, allowlisted properties: strings and integers only (money as `*_paise` + `currency`).
const Properties = z.record(z.union([z.string().max(64), z.number().int()]));

/** One accepted pixel event (collector.md §2.4). Never contains a raw phone, email, IP or user agent. */
export const StreamEventEntry = z
  .object({
    kind: z.literal('event'),
    store_id: z.string().uuid(),
    event_id: z.string().uuid(),
    event_name: z.enum(PIXEL_EVENT_NAMES),
    occurred_at: z.string().datetime({ offset: true }),
    received_at: z.string().datetime({ offset: true }),
    visitor_id: z.string().min(1).max(64),
    visitor_new: z.boolean(),
    consent_trigger: z.enum(['interaction', 'initial_state', 'refresh']).optional(),
    page_url: z.string().max(2048),
    referrer: z.string().max(2048),
    fbp: z.string().max(128).optional(),
    fbc: z.string().max(256).optional(),
    device_type: z.enum(['mobile', 'tablet', 'desktop', 'unknown']),
    os: z.string().max(64),
    browser: z.string().max(64),
    is_in_app_browser: z.union([z.literal(0), z.literal(1)]),
    geo_state: z.string().max(64),
    geo_city: z.string().max(64),
    consent_purposes: z.array(z.enum(CONSENT_PURPOSES)),
    identity: z
      .object({
        phone_hmac: VersionedHmacString.optional(),
        email_hmac: VersionedHmacString.optional(),
        identity_hash_hmac: VersionedHmacString.optional(),
      })
      .strict(),
    properties: Properties,
  })
  .strict();
export type StreamEventEntry = z.infer<typeof StreamEventEntry>;

/**
 * An erased identity was seen on a new visitor (collector.md §4 step 10). `visitor_id` is the raw
 * (pseudonymous) id: the follow-up purge deletes that visitor's rows, which are keyed by it.
 */
export const StreamSuppressionHit = z
  .object({
    kind: z.literal('suppression_hit'),
    store_id: z.string().uuid(),
    visitor_id: z.string().min(1).max(64),
    identity_hash_hmac: VersionedHmacString,
    received_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type StreamSuppressionHit = z.infer<typeof StreamSuppressionHit>;

export const StreamEntry = z.discriminatedUnion('kind', [StreamEventEntry, StreamSuppressionHit]);
export type StreamEntry = z.infer<typeof StreamEntry>;

/**
 * A stream entry as stored: two fields, `store_id` (cheap filtering — e.g. the erasure scan) and
 * `payload` (the JSON above). Both entry kinds use this one shape, so a consumer parses every entry
 * the same way; collector.md §2.4 left `suppression_hit`'s fields loose and this settles them.
 */
export const STREAM_FIELD_STORE_ID = 'store_id';
export const STREAM_FIELD_PAYLOAD = 'payload';
