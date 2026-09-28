// Adapters for Shopify, Meta, Google Ads and Shiprocket, each isolated behind the
// IntegrationAdapter interface (SPEC §8, CLAUDE.md rule 8) in its own subfolder — e.g.
// packages/integrations/src/shopify — so a provider's API version bumps stay contained.
// See docs/architecture/lld/{shopify,meta,google-ads,shiprocket}-integration.md.

export const PACKAGE_NAME = '@truepath/integrations';

export { roundDecimalToPaise } from './money.js';
export { createMetaAdapter, META_API_VERSION, type MetaAdapter } from './meta/adapter.js';
export {
  ATTRIBUTION_WINDOW as META_ATTRIBUTION_WINDOW,
  InsightsRow as MetaInsightsRowSchema,
  mapInsightsRow,
  PURCHASE_ACTION_TYPES as META_PURCHASE_ACTION_TYPES,
} from './meta/mapper.js';
export {
  decideRateLimit,
  isThrottleError,
  parseBusinessUseCaseUsage,
  parseGraphApiError,
  RATE_LIMIT_PAUSE_MS,
  throttleBackoffMs,
  THROTTLE_MAX_ATTEMPTS,
  type BusinessUseCaseUsage,
  type GraphApiError,
  type RateLimitDecision,
} from './meta/rateLimit.js';
export type {
  MetaCredentials,
  MetaHealthStatus,
  MetaInsightsRange,
  MetaInsightsResult,
  MetaSpendRow,
} from './meta/types.js';
export {
  createShopifyAdapter,
  ShopifyPixelError,
  ShopifyUnauthorizedError,
  type ShopifyAdapter,
  type ShopifyAdapterConfig,
} from './shopify/adapter.js';
export { generateSigningKey, generateStoreKey, nextSigningKid } from './shopify/pixelKeys.js';
export type {
  PixelSigningKey,
  WebPixelSettings,
  ShopifyBulkOperation,
  ShopifyBulkOrderLine,
  ShopifyCredentials,
  ShopifyHealthStatus,
  ShopifyOrderSnapshot,
  ShopifyShopInfo,
} from './shopify/types.js';
export {
  DEFAULT_COD_MAPPING,
  detectPaymentMethod,
  exceedsMoneySanityBound,
  filterNoteAttributes,
  mapOrderSnapshot,
  ORDER_MONEY_SANITY_BOUND_PAISE,
  parseMoneyToPaise,
  pincodePrefixFromZip,
  type CodMapping,
  type MappedOrderFields,
  type NoteAttribute,
} from './shopify/mapper.js';
export {
  ShopifyOrderHintWebhook,
  ShopifyOrderWebhook,
  snapshotFromOrderWebhook,
  type ShopifyOrderHintPayload,
  type ShopifyOrderWebhookPayload,
} from './shopify/webhookSchemas.js';
