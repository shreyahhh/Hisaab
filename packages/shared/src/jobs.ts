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
