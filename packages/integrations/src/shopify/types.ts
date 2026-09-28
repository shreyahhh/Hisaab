// Shopify adapter types (shopify-integration.md §2.7, SPEC §8's IntegrationAdapter). M1-1 covered
// OAuth install/uninstall; M1-2 added order-webhook mapping (fetchOrder, ShopifyOrderSnapshot);
// M1-3 adds startBulkOrders (begin the backfill bulk query only — see adapter.ts's docstring on it
// for what's deferred). upsertWebPixel, bulkResultUrl, ordersUpdatedSince and fetchOrderContact
// still land with M1-3's follow-up / M1-4.

/** Stored only in `integrations.encrypted_credentials` (ADR-0023), never in `settings`. */
export interface ShopifyCredentials {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string; // ISO 8601
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string; // ISO 8601
  readonly scope: string; // comma-separated, as Shopify returns it
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
