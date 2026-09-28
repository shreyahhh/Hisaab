import { z } from 'zod';
// BullMQ queue names and job payload types (HLD §8 job payload registry). Canonical: don't invent
// new queue names or payload shapes without adding them here first (CLAUDE.md — "Names are
// canonical").

/** HLD §8: `dsr`. The consumer lands with M4-2; until then jobs enqueued here simply wait. */
export const DSR_QUEUE = 'dsr';

/**
 * HLD §8: `DsrJob{storeId, type, requestId, visitorIds?}`. `visitorIds` restricts an erasure to a
 * follow-up purge of those (raw, pseudonymous) visitor ids — enqueued on a `suppression_hit`.
 */
export interface DsrJob {
  readonly storeId: string;
  readonly type: 'access' | 'erasure' | 'correction' | 'store_erasure';
  readonly requestId: string;
  readonly visitorIds?: readonly string[];
}

/** privacy-dpdp.md §4.5: withdrawal-triggered erasure jobs wait 60 s so a burst can be coalesced. */
export const DSR_WITHDRAWAL_DELAY_MS = 60_000;

/** HLD §8: `shopify-sync`. */
export const SHOPIFY_SYNC_QUEUE = 'shopify-sync';

export const SHOPIFY_SYNC_MODES = [
  'backfill',
  'bulk_result',
  'reconcile',
  'order_refresh',
] as const;
export type ShopifySyncMode = (typeof SHOPIFY_SYNC_MODES)[number];

/**
 * HLD §8: `ShopifySyncJob{storeId, mode, bulkOperationId?, externalOrderIds?}`.
 * - `backfill`: starts a bulk order query for the last `days` days (shopify-integration.md §4.7).
 * - `bulk_result`: processes the JSONL result of `bulkOperationId` (not yet built — tracked
 *   separately; this mode/field exists so the payload shape doesn't need to change later).
 * - `reconcile` / `order_refresh`: not yet built.
 */
export interface ShopifySyncJob {
  readonly storeId: string;
  readonly mode: ShopifySyncMode;
  readonly days?: number;
  readonly bulkOperationId?: string;
  readonly externalOrderIds?: readonly string[];
}

/** HLD §8: `identity-stitch`. */
export const IDENTITY_STITCH_QUEUE = 'identity-stitch';

/** HLD §8: `IdentityStitchJob{storeId, orderId, attempt}`. `orderId` is our `orders.id`, not Shopify's. */
export interface IdentityStitchJob {
  readonly storeId: string;
  readonly orderId: string;
  readonly attempt: 0 | 1 | 2;
}

export const IdentityStitchJobSchema = z
  .object({
    storeId: z.string().uuid(),
    orderId: z.string().uuid(),
    attempt: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  })
  .strict();

/** identity-stitching.md §2.1: attempt 1 runs 5 min after attempt 0, attempt 2 30 min after attempt 1. */
export const IDENTITY_STITCH_DELAY_MS = { 1: 5 * 60_000, 2: 30 * 60_000 } as const;

/**
 * BullMQ accepts a custom job id containing `:` only if it has exactly three parts, so
 * `stitch:<orderId>:<attempt>` is valid as the LLD wrote it and dedupes a redelivered webhook.
 */
export function identityStitchJobId(orderId: string, attempt: 0 | 1 | 2): string {
  return `stitch:${orderId}:${attempt}`;
}

/** HLD §8: `attribution-run`. Its consumer lands with M3-2; until then enqueued jobs simply wait. */
export const ATTRIBUTION_RUN_QUEUE = 'attribution-run';

/** HLD §8: `AttributionRunJob{storeId, mode, orderIds?}`. */
export interface AttributionRunJob {
  readonly storeId: string;
  readonly mode: 'incremental' | 'nightly';
  readonly orderIds?: readonly string[];
}

/**
 * `attr-<orderId>` (not the LLD's `attr:<orderId>`: two parts with a `:` are rejected by BullMQ), so
 * repeats for the same order coalesce while one is waiting.
 */
export function attributionRunJobId(orderId: string): string {
  return `attr-${orderId}`;
}

/** identity-stitching.md §4.2 step 4 / §7: a hash beyond either limit is a shared or dummy identifier. */
export const IDENTITY_GUARD = {
  maxVisitorsPerHash: 20,
  maxOrdersPerHash: 50,
  ordersWindowDays: 90,
} as const;

/** identity-stitching.md §4.3 step 3: bounds the touchpoint loads of one journey. */
export const MAX_JOURNEY_VISITORS = 10;

/**
 * The order id a pixel reports, as the numeric Shopify id `orders.external_order_id` holds. Shopify
 * doesn't document `checkout.order.id`'s format (identity-stitching.md §4.1 step 2, open question 4), so
 * both a GID (`gid://shopify/Order/5001`) and a plain number are accepted. Null for anything else.
 */
export function normaliseOrderId(raw: string): string | null {
  const trimmed = raw.trim();
  const gid = /^gid:\/\/shopify\/[A-Za-z]+\/(\d{1,20})(?:\?.*)?$/.exec(trimmed);
  if (gid) return gid[1]!;
  return /^\d{1,20}$/.test(trimmed) ? trimmed : null;
}

/**
 * Enqueue options for `identity-stitch` jobs (HLD "Error handling & retries": exponential backoff, base
 * 2 s, 5 attempts). Completed jobs are kept 30 days so a redelivered webhook's job id still dedupes.
 */
export const IDENTITY_STITCH_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { age: 30 * 86_400 },
} as const;

/** Same retry policy for the `attribution-run` jobs the stitcher enqueues (consumer lands with M3-2). */
export const ATTRIBUTION_RUN_JOB_OPTIONS = IDENTITY_STITCH_JOB_OPTIONS;
