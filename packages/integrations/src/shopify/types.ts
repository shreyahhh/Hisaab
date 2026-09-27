// Shopify adapter types (shopify-integration.md §2.7, SPEC §8's IntegrationAdapter). This ticket
// (M1-1) implements only what OAuth install/uninstall needs; upsertWebPixel, startBulkOrders,
// bulkResultUrl, ordersUpdatedSince, fetchOrder and fetchOrderContact land with M1-2/M1-3/M1-4.

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
