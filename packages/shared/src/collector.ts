import { z } from 'zod';

// The pixel → Collector contract (collector.md §2.2, §2.5) and the Collector's per-store config.
// Shared by apps/collector (validates), apps/api (publishes the config) and the pixel's contract
// test. The pixel itself deliberately imports none of the runtime values here (it is bundled for a
// browser sandbox — see apps/shopify-app/extensions/truepath-pixel); its own copies of the few
// constants are pinned to these by a test.

/** SPEC §5.3 P-5: the two purposes an event can carry. */
export const CONSENT_PURPOSES = ['attribution_analytics', 'ad_platform_measurement'] as const;
export type Purpose = (typeof CONSENT_PURPOSES)[number];

/** SPEC §7.2: reject bodies larger than this. */
export const COLLECT_MAX_BODY_BYTES = 10_240;
export const COLLECT_MAX_EVENTS_PER_BATCH = 25;
/** collector.md §4 step 3: a signature's `ts` may differ from now by at most this. */
export const COLLECT_SIGNATURE_TOLERANCE_SECONDS = 300;
/** SPEC v0.6 §7.1: how often the pixel re-asserts a still-granted consent (`trigger: 'refresh'`). */
export const CONSENT_REFRESH_INTERVAL_DAYS = 30;

/** What the pixel signs: `HMAC-SHA256(secret, collectSigningInput(ts, rawBody))`, hex (§4 step 3). */
export function collectSigningInput(ts: string | number, rawBody: string): string {
  return `${ts}.${rawBody}`;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidV7 = z.string().regex(UUID_V7);

// Shopify gives decimal MoneyV2; the pixel sends integer paise (`Math.round(amount * 100)`), the same
// unit as everywhere else in the platform. Bounded so a forged amount can't overflow downstream.
const Money = z
  .object({
    amount_paise: z.number().int().nonnegative().max(10_000_000_000),
    currency: z.string().length(3),
  })
  .strict();

// The only place a raw phone/email may appear in the whole request — hashed and dropped by the
// Collector before anything is stored (§4 step 8).
const Contact = z
  .object({
    email: z.string().max(254).optional(),
    phone: z.string().max(32).optional(),
  })
  .strict();

const Base = {
  event_id: z.string().uuid(),
  occurred_at: z.string().datetime({ offset: true }),
  page_url: z.string().url().max(2048),
  referrer: z.string().max(2048).default(''),
};

// `.strict()` everywhere: an unknown key is rejected, so no free-form property can smuggle PII into
// `events.properties` (§2.2).
export const PixelEvent = z.discriminatedUnion('event_name', [
  z.object({ event_name: z.literal('page_viewed'), ...Base }).strict(),
  z
    .object({
      event_name: z.literal('product_viewed'),
      ...Base,
      properties: z
        .object({
          product_id: z.string().max(64),
          variant_id: z.string().max(64),
          price: Money,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event_name: z.literal('product_added_to_cart'),
      ...Base,
      properties: z
        .object({
          product_id: z.string().max(64),
          variant_id: z.string().max(64),
          quantity: z.number().int().positive().max(999),
          line_total: Money,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event_name: z.literal('checkout_started'),
      ...Base,
      properties: z.object({ checkout_token: z.string().max(64), total: Money }).strict(),
    })
    .strict(),
  z
    .object({
      event_name: z.literal('checkout_contact_info_submitted'),
      ...Base,
      properties: z.object({ checkout_token: z.string().max(64) }).strict(),
      contact: Contact,
    })
    .strict(),
  z
    .object({
      event_name: z.literal('checkout_completed'),
      ...Base,
      properties: z
        .object({
          checkout_token: z.string().max(64),
          order_id: z.string().max(64),
          total: Money,
        })
        .strict(),
      contact: Contact,
    })
    .strict(),
  z
    .object({
      event_name: z.literal('consent_granted'),
      ...Base,
      // interaction: `visitorConsentCollected` fired; initial_state: read from `init.customerPrivacy`
      // at load; refresh: the periodic re-assertion (SPEC v0.6 — feeds the default-on signal, P-1).
      trigger: z.enum(['interaction', 'initial_state', 'refresh']),
    })
    .strict(),
  z.object({ event_name: z.literal('consent_withdrawn'), ...Base }).strict(),
]);
export type PixelEvent = z.infer<typeof PixelEvent>;
export type PixelEventName = PixelEvent['event_name'];

export const PIXEL_EVENT_NAMES = [
  'page_viewed',
  'product_viewed',
  'product_added_to_cart',
  'checkout_started',
  'checkout_contact_info_submitted',
  'checkout_completed',
  'consent_granted',
  'consent_withdrawn',
] as const satisfies readonly PixelEventName[];

export const CollectBatch = z
  .object({
    v: z.literal(1),
    visitor_id: uuidV7,
    // True only on the batch in which the pixel created `visitor_id` (default-on signal, SPEC v0.6).
    visitor_new: z.boolean(),
    sent_at: z.string().datetime({ offset: true }),
    consent: z
      .object({
        analytics: z.boolean(), // init.customerPrivacy.analyticsProcessingAllowed / latest visitorConsentCollected
        marketing: z.boolean(), // marketingAllowed
        notice_version: z.string().min(1).max(32),
      })
      .strict(),
    // Sent only with marketing consent; otherwise omitted (§2.2).
    click: z
      .object({
        fbp: z.string().max(128).optional(),
        fbc: z.string().max(256).optional(),
      })
      .strict()
      .optional(),
    events: z.array(PixelEvent).min(1).max(COLLECT_MAX_EVENTS_PER_BATCH),
  })
  .strict();
export type CollectBatch = z.infer<typeof CollectBatch>;

/** Why a store's collector config is `inactive` (HLD §8 `collector:store:<store_key>`). */
export const COLLECTOR_INACTIVE_REASONS = [
  'dpa_missing',
  'consent_region_unconfirmed',
  'consent_default_on_detected',
  'consent_policy_not_required',
  'uninstalled',
  'org_deletion',
] as const;
export type CollectorInactiveReason = (typeof COLLECTOR_INACTIVE_REASONS)[number];

/**
 * The value at `collector:store:<store_key>` (HLD §8; collector.md §2.5), written by Core API and read
 * by the Collector. Holds the pixel signing secret because the pixel itself ships it (§6) — never a
 * credential that could do anything else.
 */
export const CollectorStoreConfig = z
  .object({
    storeId: z.string().uuid(),
    // 'active' only with the DPA accepted AND India opt-in confirmed (privacy-dpdp §4.10).
    status: z.enum(['active', 'inactive']),
    inactiveReason: z.enum(COLLECTOR_INACTIVE_REASONS).nullable(),
    allowedOrigins: z.array(z.string().url()).max(20),
    signingKeys: z
      .array(z.object({ kid: z.string().max(16), secret: z.string().min(32) }).strict())
      .min(1)
      .max(2), // two during a rotation (S-6)
    childDirected: z.boolean(),
    noticeVersion: z.string(),
  })
  .strict()
  // An inactive store must say why, and an active one must not (a stale reason would mislead the
  // health screen).
  .refine((c) => (c.status === 'inactive') === (c.inactiveReason !== null), {
    message: 'inactiveReason must be set exactly when status is inactive',
    path: ['inactiveReason'],
  });
export type CollectorStoreConfig = z.infer<typeof CollectorStoreConfig>;

/** `collector:store:<store_key>` (HLD §8). */
export function collectorStoreKey(storeKey: string): string {
  return `collector:store:${storeKey}`;
}

/** `pk_` + 24 base62 characters — the pixel's public store key (shopify-integration.md §4.1 step 5). */
export const STORE_KEY_PATTERN = /^pk_[0-9A-Za-z]{24}$/;
