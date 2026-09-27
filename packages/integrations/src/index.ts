// Adapters for Shopify, Meta, Google Ads and Shiprocket, each isolated behind the
// IntegrationAdapter interface (SPEC §8, CLAUDE.md rule 8) in its own subfolder — e.g.
// packages/integrations/src/shopify — so a provider's API version bumps stay contained.
// See docs/architecture/lld/{shopify,meta,google-ads,shiprocket}-integration.md.

export const PACKAGE_NAME = '@truepath/integrations';

export {
  createShopifyAdapter,
  type ShopifyAdapter,
  type ShopifyAdapterConfig,
} from './shopify/adapter.js';
export type { ShopifyCredentials, ShopifyHealthStatus, ShopifyShopInfo } from './shopify/types.js';
