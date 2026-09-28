// Shopify adapter types (shopify-integration.md §2.7, SPEC §8's IntegrationAdapter). M1-1 covered
// OAuth install/uninstall; M1-2 added order-webhook mapping (fetchOrder, ShopifyOrderSnapshot);
// M1-3 adds startBulkOrders (begin the backfill bulk query only — see adapter.ts's docstring on it
// for what's deferred). upsertWebPixel, bulkResultUrl, ordersUpdatedSince and fetchOrderContact
// still land with M1-3's follow-up / M1-4.

/** A pixel signing key (shopify-integration.md §4.1 step 5): `kid` is public, `secret` is not stored anywhere but here. */
export interface PixelSigningKey {
  readonly kid: string;
  readonly secret: string;
}

/** Stored only in `integrations.encrypted_credentials` (ADR-0023), never in `settings`. */
export interface ShopifyCredentials {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string; // ISO 8601
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string; // ISO 8601
  readonly scope: string; // comma-separated, as Shopify returns it
  /**
   * The pixel's HMAC signing keys — one, or two during a rotation (collector.md §2.5). They live in
   * the same envelope as the OAuth tokens (SPEC v0.3 secrets rule). `refresh` carries them through; a
   * fresh `exchangeCode` does not have them, so a reconnect must copy them over (apps/api).
   */
  readonly pixelSigningKeys?: readonly PixelSigningKey[];
}

/** The pixel extension's `[settings]` (extensions/truepath-pixel/shopify.extension.toml). */
export interface WebPixelSettings {
  readonly storeKey: string;
  readonly collectorUrl: string;
  readonly signingKid: string;
  readonly signingSecret: string;
  readonly noticeVersion: string;
}

export interface ShopifyShopInfo {
  readonly gid: string; // e.g. "gid://shopify/Shop/123"
  readonly myshopifyDomain: string;
  readonly currency: string;
}

export interface ShopifyHealthStatus {
  readonly healthy: boolean;
  readonly reason?: string;
}

/**
 * Unified order shape both the REST webhook payload and the GraphQL `fetchOrder` response are
 * converted into (shopify-integration.md §2.5), so `mapper.ts`'s field mapping is a single pure
 * function regardless of which source produced the data. Money fields are decimal strings (e.g.
 * `"1299.00"`), never parsed here — `parseMoneyToPaise` (mapper.ts) owns that, with no float path.
 */
export interface ShopifyOrderSnapshot {
  readonly externalOrderId: string;
  readonly createdAtPlatform: string; // ISO 8601
  /** The snapshot's own version timestamp — what the out-of-order guard compares. */
  readonly updatedAtPlatform: string; // ISO 8601
  readonly cancelledAt: string | null; // ISO 8601
  readonly currency: string; // ISO 4217, e.g. "INR"
  readonly totalPrice: string;
  /** GraphQL only (`totalRefundedSet`) — null from a REST webhook snapshot (LLD §2.5). */
  readonly totalRefunded: string | null;
  readonly totalOutstanding: string | null;
  readonly financialStatus: string | null;
  readonly fulfillmentStatus: string | null;
  readonly paymentGatewayNames: readonly string[];
  /** Protected customer data (Level 2, docs/m0-7-external-setup.md item 3) — null when unapproved. */
  readonly email: string | null;
  readonly phone: string | null;
  readonly shippingAddressZip: string | null;
  readonly landingSite: string | null;
  readonly referringSite: string | null;
  readonly noteAttributes: readonly { readonly name: string; readonly value: string | null }[];
  readonly discountCodes: readonly string[];
}

/** Shopify's `BulkOperation` object, narrowed to what `bulk_result` needs (shopify-integration.md §4.7). */
export interface ShopifyBulkOperation {
  readonly id: string;
  /** `CREATED | RUNNING | COMPLETED | FAILED | CANCELED | CANCELING | EXPIRED` — kept a string so a
   * value Shopify adds later doesn't fail parsing; callers compare against the ones they handle. */
  readonly status: string;
  readonly errorCode: string | null;
  /** How many top-level objects (orders) Shopify says the query produced — what the result file
   * should contain, so the worker can reconcile it against what it actually applied. */
  readonly rootObjectCount: number;
  /** Signed JSONL URL, valid for a week; null until COMPLETED (or when the query matched nothing). */
  readonly url: string | null;
  /** Present on FAILED/CANCELED operations that produced some output. */
  readonly partialDataUrl: string | null;
}

/** One JSONL line of a bulk orders result: a usable order, or a line that could not be parsed.
 * Invalid lines carry no content — the raw line may hold protected customer data. */
export type ShopifyBulkOrderLine =
  | { readonly kind: 'order'; readonly snapshot: ShopifyOrderSnapshot }
  | { readonly kind: 'invalid' };
