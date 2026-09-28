import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { SHOPIFY_API_VERSION } from '@truepath/shared';
import type {
  ShopifyCredentials,
  ShopifyHealthStatus,
  ShopifyOrderSnapshot,
  ShopifyShopInfo,
} from './types.js';

// Shopify OAuth + webhook-verification adapter (shopify-integration.md §2.7, §4.1, §4.2). Field
// names and endpoints verified against
// https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
// (2026-09) — this is the classic redirect-based authorization-code grant, not the App-Bridge
// token-exchange flow, since our connect flow is a plain server redirect (LLD §4.1 step 1).

/**
 * Thrown by `fetchOrder` on a 401 — distinguishable from other failures so a caller holding a stored
 * access token (apps/api's order-hint webhook handler, M1-2) can refresh once and retry, instead of
 * treating every failure the same way.
 */
export class ShopifyUnauthorizedError extends Error {
  constructor() {
    super('Shopify order query returned 401');
    this.name = 'ShopifyUnauthorizedError';
  }
}

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
  /**
   * Full GraphQL order snapshot, for `refunds/*`/`fulfillments/*` hints and for a partial-hint
   * webhook whose order doesn't exist locally yet (shopify-integration.md §4.4/§4.5, M1-2). Retries
   * a throttled response **once**, with a short fixed delay, then fails fast — this is called from
   * inside a webhook handler, which must respond well within Shopify's 5-second timeout, so it
   * cannot afford the LLD's full backfill-style backoff (1s→32s). A caller that needs the data
   * should let the thrown error propagate so Shopify's own retry (up to 8x over 4h) tries again
   * later, rather than block this request.
   *
   * **Must be called before opening any database transaction** — this is a network call, and
   * nothing in this codebase may hold a Postgres row lock across one (see orderRepository.ts, which
   * has no reference to this adapter at all, by design, so it structurally cannot violate this).
   * Returns `null` if Shopify has no such order (not an error).
   */
  fetchOrder(
    shop: string,
    creds: ShopifyCredentials,
    externalOrderId: string,
  ): Promise<ShopifyOrderSnapshot | null>;
  /**
   * Starts an async bulk query for every order created on or after `sinceIso`
   * (shopify-integration.md §4.7 "backfill"). Returns the bulk operation's GID. The actual JSONL
   * result is fetched later by a handler for the `bulk_operations/finish` webhook — that "bulk_result"
   * mode is a separate, not-yet-built ticket; this method only starts the query.
   */
  startBulkOrders(shop: string, creds: ShopifyCredentials, sinceIso: string): Promise<string>;
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

// shopify-integration.md §2.5's OrderSnapshot fragment, minus customerJourneySummary — M1-2
// doesn't use it (is_first_order and note_attributes' UTM fallback are documented-fallback-only
// until M1-7/M1-3 add the enrichment pass), so it isn't queried at all, keeping the query's cost low.
const OrderNode = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  cancelledAt: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  totalPriceSet: z.object({
    shopMoney: z.object({ amount: z.string(), currencyCode: z.string() }),
  }),
  totalRefundedSet: z.object({ shopMoney: z.object({ amount: z.string() }) }),
  totalOutstandingSet: z.object({ shopMoney: z.object({ amount: z.string() }) }),
  paymentGatewayNames: z.array(z.string()),
  displayFinancialStatus: z.string().nullable(),
  displayFulfillmentStatus: z.string().nullable(),
  discountCodes: z.array(z.string()),
  shippingAddress: z
    .object({ zip: z.string().nullable(), phone: z.string().nullable() })
    .nullable(),
});

const OrderQueryResponse = z.object({
  data: z.object({ order: OrderNode.nullable() }),
});

// Shared between the single-order query and the bulk backfill query, so both stay in sync and
// `mapOrderNodeToSnapshot` handles either one's rows identically.
const ORDER_FIELDS = `
  id createdAt updatedAt cancelledAt email phone
  totalPriceSet { shopMoney { amount currencyCode } }
  totalRefundedSet { shopMoney { amount } }
  totalOutstandingSet { shopMoney { amount } }
  paymentGatewayNames displayFinancialStatus displayFulfillmentStatus
  discountCodes
  shippingAddress { zip phone }
`;

const ORDER_QUERY = `
  query($id: ID!) {
    order(id: $id) {
      ${ORDER_FIELDS}
    }
  }
`;

function toOrderGid(externalOrderId: string): string {
  return externalOrderId.startsWith('gid://')
    ? externalOrderId
    : `gid://shopify/Order/${externalOrderId}`;
}

function mapOrderNodeToSnapshot(order: z.infer<typeof OrderNode>): ShopifyOrderSnapshot {
  return {
    externalOrderId: order.id.split('/').pop() ?? order.id,
    createdAtPlatform: order.createdAt,
    updatedAtPlatform: order.updatedAt,
    cancelledAt: order.cancelledAt,
    currency: order.totalPriceSet.shopMoney.currencyCode,
    totalPrice: order.totalPriceSet.shopMoney.amount,
    totalRefunded: order.totalRefundedSet.shopMoney.amount,
    totalOutstanding: order.totalOutstandingSet.shopMoney.amount,
    financialStatus: order.displayFinancialStatus,
    fulfillmentStatus: order.displayFulfillmentStatus,
    paymentGatewayNames: order.paymentGatewayNames,
    email: order.email,
    phone: order.phone ?? order.shippingAddress?.phone ?? null,
    shippingAddressZip: order.shippingAddress?.zip ?? null,
    landingSite: null, // GraphQL fetchOrder is only used for hints/backfill-of-missing-order; the
    referringSite: null, // REST orders/create webhook is the (only, for M1-2) source of these two.
    noteAttributes: [], // customAttributes intentionally not queried — see OrderNode's comment above.
    discountCodes: order.discountCodes,
  };
}

// Called from inside a webhook handler that must answer well within Shopify's 5 s timeout — kept
// deliberately small. shopify-integration.md §4.7's full cost-based backoff (1s→32s, 6 tries) is
// for backfill/reconcile, which aren't request/response bound; this is not that.
const ORDER_FETCH_MAX_ATTEMPTS = 2;
const ORDER_FETCH_RETRY_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shopify signals GraphQL throttling either as HTTP 429 or as a 200 with a "Throttled" error entry. */
function isThrottledResponse(status: number, body: unknown): boolean {
  if (status === 429) return true;
  if (body && typeof body === 'object' && 'errors' in body) {
    const errors = (body as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      return errors.some(
        (e) =>
          typeof e === 'object' &&
          e !== null &&
          /throttled/i.test(String((e as { message?: unknown }).message ?? '')),
      );
    }
  }
  return false;
}

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

async function fetchOrder(
  shop: string,
  creds: ShopifyCredentials,
  externalOrderId: string,
): Promise<ShopifyOrderSnapshot | null> {
  const gid = toOrderGid(externalOrderId);
  for (let attempt = 1; attempt <= ORDER_FETCH_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Shopify-Access-Token': creds.accessToken,
      },
      body: JSON.stringify({ query: ORDER_QUERY, variables: { id: gid } }),
    });
    if (response.status === 401) {
      throw new ShopifyUnauthorizedError();
    }
    if (!response.ok && response.status !== 429) {
      throw new Error(`Shopify order query returned ${response.status}`);
    }
    const body: unknown = await response.json();
    if (isThrottledResponse(response.status, body)) {
      if (attempt < ORDER_FETCH_MAX_ATTEMPTS) {
        await sleep(ORDER_FETCH_RETRY_DELAY_MS);
        continue;
      }
      throw new Error(
        'Shopify order query throttled after retrying; failing fast to stay within the webhook timeout',
      );
    }
    const parsed = OrderQueryResponse.safeParse(body);
    if (!parsed.success) {
      throw new Error('Shopify order query returned an unexpected response shape');
    }
    const order = parsed.data.data.order;
    return order ? mapOrderNodeToSnapshot(order) : null;
  }
  // Unreachable: every loop iteration above returns, throws, or (on the last attempt) throws —
  // this satisfies the return type for a plain `for` loop, which TS can't otherwise prove exhaustive.
  throw new Error('fetchOrder: exhausted attempts without a result');
}

const BulkOperationRunQueryResponse = z.object({
  data: z.object({
    bulkOperationRunQuery: z.object({
      bulkOperation: z.object({ id: z.string().min(1), status: z.string() }).nullable(),
      userErrors: z.array(z.object({ field: z.array(z.string()).nullable(), message: z.string() })),
    }),
  }),
});

// Shopify's order search syntax takes a plain date (shopify-integration.md §4.7); the query itself
// is submitted as a GraphQL block string (`"""..."""`), so the embedded double quotes around the
// search filter are safe — only a literal `"""` would terminate the block early.
function bulkOrdersQuery(sinceIso: string): string {
  const sinceDate = sinceIso.slice(0, 10);
  return `
    mutation {
      bulkOperationRunQuery(
        query: """
        {
          orders(query: "created_at:>=${sinceDate}") {
            edges {
              node {
                ${ORDER_FIELDS}
              }
            }
          }
        }
        """
      ) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }
  `;
}

async function startBulkOrders(
  shop: string,
  creds: ShopifyCredentials,
  sinceIso: string,
): Promise<string> {
  const response = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Shopify-Access-Token': creds.accessToken,
    },
    body: JSON.stringify({ query: bulkOrdersQuery(sinceIso) }),
  });
  if (response.status === 401) {
    throw new ShopifyUnauthorizedError();
  }
  if (!response.ok) {
    throw new Error(`Shopify bulkOperationRunQuery returned ${response.status}`);
  }
  const parsed = BulkOperationRunQueryResponse.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Shopify bulkOperationRunQuery returned an unexpected response shape');
  }
  const { bulkOperation, userErrors } = parsed.data.data.bulkOperationRunQuery;
  if (userErrors.length > 0) {
    throw new Error(
      `Shopify bulkOperationRunQuery rejected the query: ${userErrors.map((e) => e.message).join('; ')}`,
    );
  }
  if (!bulkOperation) {
    throw new Error(
      'Shopify bulkOperationRunQuery returned neither a bulkOperation nor userErrors',
    );
  }
  return bulkOperation.id;
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

    fetchOrder,

    startBulkOrders,

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
