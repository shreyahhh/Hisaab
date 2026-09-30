import { z } from 'zod';

// Shopify-specific constants and env config shared between packages/integrations/shopify and
// apps/api (shopify-integration.md §2.2/§2.3, ADR-0024).

// e.g. "my-store.myshopify.com". Lowercase only — Shopify's own domains are lowercase, and callers
// normalise (`.toLowerCase()`) before testing so a merchant-typed mixed-case value still matches.
export const SHOPIFY_SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function isShopifyShopDomain(value: string): boolean {
  return SHOPIFY_SHOP_DOMAIN_PATTERN.test(value);
}

// Admin API version: one constant, pinned (CLAUDE.md rule 8; shopify-integration.md header).
// Supported until 2027-07-16 per Shopify's versioning policy.
export const SHOPIFY_API_VERSION = '2026-07';

// SPEC §8.1 v0.3 / m0-7-external-setup.md item 2: read_all_orders is requested but not yet
// approved, so it is not in the base scope string here — it is added once granted (§4.7).
//
// read_fulfillments (issue #73): required by Shopify to subscribe to the fulfillments/create and
// fulfillments/update webhook topics SPEC §8.1 already lists — `shopify app deploy` refuses to
// create a version without it once those topics are declared in shopify.app.toml. A store connected
// before this scope was added won't receive those two topics until it reconnects (Shopify only
// grants a newly-added scope on a fresh OAuth authorization, not retroactively for an existing
// token) — orders/refunds/app/compliance topics are unaffected, since read_orders already covers them.
export const SHOPIFY_OAUTH_SCOPES = [
  'read_orders',
  'read_fulfillments',
  'write_pixels',
  'read_customer_events',
] as const;

// OAuth client config + our own app base URL (used to build the callback redirect_uri and the
// OAuth state token's signing secret, ADR-0025). No defaults: a missing value must fail boot, not
// silently disable the integration.
export const shopifyEnvSchema = z.object({
  SHOPIFY_CLIENT_ID: z.string().min(1),
  SHOPIFY_CLIENT_SECRET: z.string().min(1),
  // Accepts the current and, during a rotation window, the previous client secret
  // (shopify-integration.md §4.2, S-6). Optional: unset outside a rotation.
  SHOPIFY_CLIENT_SECRET_PREVIOUS: z.string().min(1).optional(),
  SHOPIFY_APP_URL: z.string().url(),
  // Signs the OAuth state token (ADR-0025) — distinct from BETTER_AUTH_SECRET and from the
  // identity/credentials master keys, so compromising one secret never helps forge another.
  SHOPIFY_OAUTH_STATE_SECRET: z.string().min(32),
});
export type ShopifyEnv = z.infer<typeof shopifyEnvSchema>;
