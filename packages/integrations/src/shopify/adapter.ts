import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { SHOPIFY_API_VERSION } from '@truepath/shared';
import type { ShopifyCredentials, ShopifyHealthStatus, ShopifyShopInfo } from './types.js';

// Shopify OAuth + webhook-verification adapter (shopify-integration.md §2.7, §4.1, §4.2). Field
// names and endpoints verified against
// https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
// (2026-09) — this is the classic redirect-based authorization-code grant, not the App-Bridge
// token-exchange flow, since our connect flow is a plain server redirect (LLD §4.1 step 1).

export interface ShopifyAdapterConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Accepted alongside `clientSecret` during a rotation window (S-6). */
  readonly clientSecretPrevious?: string;
  readonly scopes: readonly string[];
}

export interface ShopifyAdapter {
  readonly provider: 'shopify';
  /** Builds the `/admin/oauth/authorize` URL. `redirectUri` must exactly match the app's one
   * registered redirect URL (ADR-0024) — it is a fixed constant the caller supplies, not built here. */
  authUrl(shop: string, state: string, redirectUri: string): string;
  /** Exchanges an authorization code for an expiring offline token (`expiring=1`). */
  exchangeCode(shop: string, code: string): Promise<ShopifyCredentials>;
  /** Rotates the access + refresh token pair before the access token expires (shopify-integration.md §4.1 step 3). */
  refresh(shop: string, creds: ShopifyCredentials): Promise<ShopifyCredentials>;
  /** GraphQL Admin API `shop { id myshopifyDomain currencyCode }`. */
  shopInfo(shop: string, creds: ShopifyCredentials): Promise<ShopifyShopInfo>;
  /** Token validity only for M1-1; the full health screen (scopes, pixel, consent) is M2-4. */
  healthCheck(shop: string, creds: ShopifyCredentials): Promise<ShopifyHealthStatus>;
  /** HMAC-SHA256 of the raw body, base64, timing-safe, against the current and previous client secret. */
  verifyWebhook(rawBody: Buffer, hmacHeaderValue: string): boolean;
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token_expires_in: z.number().int().positive(),
  scope: z.string(),
});

const ShopQueryResponse = z.object({
  data: z.object({
    shop: z.object({
      id: z.string().min(1),
      myshopifyDomain: z.string().min(1),
      currencyCode: z.string().min(1),
    }),
  }),
});

function tokenExpiryIso(secondsFromNow: number): string {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

async function requestToken(
  shop: string,
  config: ShopifyAdapterConfig,
  body: Record<string, string>,
): Promise<ShopifyCredentials> {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...body,
    }),
  });
  if (!response.ok) {
    throw new Error(`Shopify token endpoint returned ${response.status}`);
  }
  const parsed = TokenResponse.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Shopify token endpoint returned an unexpected response shape');
  }
  const data = parsed.data;
  return {
    accessToken: data.access_token,
    accessTokenExpiresAt: tokenExpiryIso(data.expires_in),
    refreshToken: data.refresh_token,
    refreshTokenExpiresAt: tokenExpiryIso(data.refresh_token_expires_in),
    scope: data.scope,
  };
}

/** Constant-time compare of two possibly-different-length base64 strings (never throws on length mismatch). */
function timingSafeBase64Equal(a: string, b: string): boolean {
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, 'base64');
    bufB = Buffer.from(b, 'base64');
  } catch {
    return false;
  }
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

async function fetchShopInfo(shop: string, creds: ShopifyCredentials): Promise<ShopifyShopInfo> {
  const response = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Shopify-Access-Token': creds.accessToken,
    },
    body: JSON.stringify({ query: '{ shop { id myshopifyDomain currencyCode } }' }),
  });
  if (!response.ok) {
    throw new Error(`Shopify shop query returned ${response.status}`);
  }
  const parsed = ShopQueryResponse.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Shopify shop query returned an unexpected response shape');
  }
  const shopData = parsed.data.data.shop;
  return {
    gid: shopData.id,
    myshopifyDomain: shopData.myshopifyDomain,
    currency: shopData.currencyCode,
  };
}

export function createShopifyAdapter(config: ShopifyAdapterConfig): ShopifyAdapter {
  return {
    provider: 'shopify',

    authUrl(shop, state, redirectUri) {
      const query = new URLSearchParams({
        client_id: config.clientId,
        scope: config.scopes.join(','),
        redirect_uri: redirectUri,
        state,
      });
      return `https://${shop}/admin/oauth/authorize?${query.toString()}`;
    },

    exchangeCode(shop, code) {
      return requestToken(shop, config, { code, expiring: '1' });
    },

    refresh(shop, creds) {
      return requestToken(shop, config, {
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
      });
    },

    shopInfo: fetchShopInfo,

    async healthCheck(shop, creds) {
      try {
        await fetchShopInfo(shop, creds);
        return { healthy: true };
      } catch (error) {
        return { healthy: false, reason: error instanceof Error ? error.message : 'unknown_error' };
      }
    },

    verifyWebhook(rawBody, hmacHeaderValue) {
      const secrets = [config.clientSecret, config.clientSecretPrevious].filter(
        (s): s is string => typeof s === 'string' && s.length > 0,
      );
      return secrets.some((secret) => {
        const computed = createHmac('sha256', secret).update(rawBody).digest('base64');
        return timingSafeBase64Equal(computed, hmacHeaderValue);
      });
    },
  };
}
