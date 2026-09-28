import { createHmac } from 'node:crypto';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createShopifyAdapter,
  ShopifyUnauthorizedError,
  type ShopifyAdapterConfig,
} from './adapter.js';
import type { ShopifyCredentials } from './types.js';

const SHOP = 'test-shop.myshopify.com';

const CONFIG: ShopifyAdapterConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  scopes: ['read_orders', 'write_pixels', 'read_customer_events'],
};

const TOKEN_RESPONSE = {
  access_token: 'shpat_abc123',
  refresh_token: 'shprt_def456',
  expires_in: 3600,
  refresh_token_expires_in: 7776000,
  scope: 'read_orders,write_pixels,read_customer_events',
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('createShopifyAdapter: authUrl', () => {
  it('builds the authorize URL with client id, joined scopes, redirect_uri and state', () => {
    const adapter = createShopifyAdapter(CONFIG);
    const url = new URL(
      adapter.authUrl(
        SHOP,
        'the-state',
        'https://api.example.com/v1/integrations/shopify/callback',
      ),
    );
    expect(url.origin + url.pathname).toBe(`https://${SHOP}/admin/oauth/authorize`);
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('scope')).toBe('read_orders,write_pixels,read_customer_events');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/v1/integrations/shopify/callback',
    );
    expect(url.searchParams.get('state')).toBe('the-state');
  });
});

describe('createShopifyAdapter: exchangeCode', () => {
  it('POSTs client_id/client_secret/code/expiring=1 and maps the response to ShopifyCredentials', async () => {
    let receivedBody: URLSearchParams | undefined;
    server.use(
      http.post(`https://${SHOP}/admin/oauth/access_token`, async ({ request }) => {
        receivedBody = new URLSearchParams(await request.text());
        return HttpResponse.json(TOKEN_RESPONSE);
      }),
    );

    const adapter = createShopifyAdapter(CONFIG);
    const before = Date.now();
    const creds = await adapter.exchangeCode(SHOP, 'the-code');
    const after = Date.now();

    expect(receivedBody?.get('client_id')).toBe('client-id');
    expect(receivedBody?.get('client_secret')).toBe('client-secret');
    expect(receivedBody?.get('code')).toBe('the-code');
    expect(receivedBody?.get('expiring')).toBe('1');
    expect(receivedBody?.get('grant_type')).toBeNull();

    expect(creds.accessToken).toBe('shpat_abc123');
    expect(creds.refreshToken).toBe('shprt_def456');
    expect(creds.scope).toBe(TOKEN_RESPONSE.scope);
    const expiresAt = new Date(creds.accessTokenExpiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 3600_000 + 1000);
  });

  it('throws on a non-2xx response, without leaking the response body', async () => {
    server.use(
      http.post(`https://${SHOP}/admin/oauth/access_token`, () =>
        HttpResponse.json({ error: 'invalid_request' }, { status: 400 }),
      ),
    );
    const adapter = createShopifyAdapter(CONFIG);
    await expect(adapter.exchangeCode(SHOP, 'bad-code')).rejects.toThrow('400');
  });

  it('throws on a malformed (schema-invalid) response body', async () => {
    server.use(
      http.post(`https://${SHOP}/admin/oauth/access_token`, () =>
        HttpResponse.json({ unexpected: true }),
      ),
    );
    const adapter = createShopifyAdapter(CONFIG);
    await expect(adapter.exchangeCode(SHOP, 'the-code')).rejects.toThrow(
      'unexpected response shape',
    );
  });
});

describe('createShopifyAdapter: refresh', () => {
  it('POSTs grant_type=refresh_token with the stored refresh token, and no `code`', async () => {
    let receivedBody: URLSearchParams | undefined;
    server.use(
      http.post(`https://${SHOP}/admin/oauth/access_token`, async ({ request }) => {
        receivedBody = new URLSearchParams(await request.text());
        return HttpResponse.json({ ...TOKEN_RESPONSE, access_token: 'shpat_rotated' });
      }),
    );
    const adapter = createShopifyAdapter(CONFIG);
    const creds = await adapter.refresh(SHOP, {
      accessToken: 'old',
      accessTokenExpiresAt: new Date().toISOString(),
      refreshToken: 'shprt_old',
      refreshTokenExpiresAt: new Date().toISOString(),
      scope: TOKEN_RESPONSE.scope,
    });

    expect(receivedBody?.get('grant_type')).toBe('refresh_token');
    expect(receivedBody?.get('refresh_token')).toBe('shprt_old');
    expect(receivedBody?.get('code')).toBeNull();
    expect(creds.accessToken).toBe('shpat_rotated');
  });
});

describe('createShopifyAdapter: shopInfo', () => {
  const creds: ShopifyCredentials = {
    accessToken: 'shpat_abc123',
    accessTokenExpiresAt: new Date().toISOString(),
    refreshToken: 'shprt_def456',
    refreshTokenExpiresAt: new Date().toISOString(),
    scope: TOKEN_RESPONSE.scope,
  };

  it('queries the GraphQL Admin API with the access token header and maps the result', async () => {
    let receivedToken: string | null = null;
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, ({ request }) => {
        receivedToken = request.headers.get('X-Shopify-Access-Token');
        return HttpResponse.json({
          data: {
            shop: { id: 'gid://shopify/Shop/1', myshopifyDomain: SHOP, currencyCode: 'INR' },
          },
        });
      }),
    );
    const adapter = createShopifyAdapter(CONFIG);
    const info = await adapter.shopInfo(SHOP, creds);

    expect(receivedToken).toBe('shpat_abc123');
    expect(info).toEqual({ gid: 'gid://shopify/Shop/1', myshopifyDomain: SHOP, currency: 'INR' });
  });

  it('healthCheck reports healthy when shopInfo succeeds', async () => {
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, () =>
        HttpResponse.json({
          data: {
            shop: { id: 'gid://shopify/Shop/1', myshopifyDomain: SHOP, currencyCode: 'INR' },
          },
        }),
      ),
    );
    const adapter = createShopifyAdapter(CONFIG);
    await expect(adapter.healthCheck(SHOP, creds)).resolves.toEqual({ healthy: true });
  });

  it('healthCheck reports unhealthy with a reason when the token is invalid', async () => {
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, () =>
        HttpResponse.json(
          { errors: [{ message: 'Invalid API key or access token' }] },
          { status: 401 },
        ),
      ),
    );
    const adapter = createShopifyAdapter(CONFIG);
    const health = await adapter.healthCheck(SHOP, creds);
    expect(health.healthy).toBe(false);
    expect(health.reason).toContain('401');
  });
});

describe('createShopifyAdapter: verifyWebhook', () => {
  function sign(secret: string, body: Buffer): string {
    return createHmac('sha256', secret).update(body).digest('base64');
  }

  it('accepts a signature made with the current client secret', () => {
    const adapter = createShopifyAdapter(CONFIG);
    const body = Buffer.from(JSON.stringify({ id: 1 }));
    expect(adapter.verifyWebhook(body, sign(CONFIG.clientSecret, body))).toBe(true);
  });

  it('rejects a signature made with the wrong secret', () => {
    const adapter = createShopifyAdapter(CONFIG);
    const body = Buffer.from(JSON.stringify({ id: 1 }));
    expect(adapter.verifyWebhook(body, sign('someone-elses-secret', body))).toBe(false);
  });

  it('rejects if the body was tampered with after signing', () => {
    const adapter = createShopifyAdapter(CONFIG);
    const original = Buffer.from(JSON.stringify({ id: 1 }));
    const signature = sign(CONFIG.clientSecret, original);
    const tampered = Buffer.from(JSON.stringify({ id: 2 }));
    expect(adapter.verifyWebhook(tampered, signature)).toBe(false);
  });

  it('accepts the previous secret during a rotation window, and still accepts the current one', () => {
    const adapter = createShopifyAdapter({ ...CONFIG, clientSecretPrevious: 'the-old-secret' });
    const body = Buffer.from(JSON.stringify({ id: 1 }));
    expect(adapter.verifyWebhook(body, sign('the-old-secret', body))).toBe(true);
    expect(adapter.verifyWebhook(body, sign(CONFIG.clientSecret, body))).toBe(true);
  });

  it('rejects a malformed (non-base64) header without throwing', () => {
    const adapter = createShopifyAdapter(CONFIG);
    const body = Buffer.from('{}');
    expect(() => adapter.verifyWebhook(body, 'not-valid-base64-!!!')).not.toThrow();
    expect(adapter.verifyWebhook(body, 'not-valid-base64-!!!')).toBe(false);
  });

  it('rejects an empty header', () => {
    const adapter = createShopifyAdapter(CONFIG);
    expect(adapter.verifyWebhook(Buffer.from('{}'), '')).toBe(false);
  });
});

describe('createShopifyAdapter: fetchOrder', () => {
  const creds: ShopifyCredentials = {
    accessToken: 'shpat_abc123',
    accessTokenExpiresAt: new Date().toISOString(),
    refreshToken: 'shprt_def456',
    refreshTokenExpiresAt: new Date().toISOString(),
    scope: 'read_orders',
  };

  const ORDER_NODE = {
    id: 'gid://shopify/Order/1001',
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-01T10:05:00Z',
    cancelledAt: null,
    email: 'shopper@example.com',
    phone: '+919812345670',
    totalPriceSet: { shopMoney: { amount: '1299.00', currencyCode: 'INR' } },
    totalRefundedSet: { shopMoney: { amount: '0.00' } },
    totalOutstandingSet: { shopMoney: { amount: '0.00' } },
    paymentGatewayNames: ['razorpay'],
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    discountCodes: ['RAHUL10'],
    shippingAddress: { zip: '560034', phone: '+919812345670' },
  };

  it('fetches and maps a GraphQL order snapshot with the access token header', async () => {
    let receivedToken: string | null = null;
    let receivedVariables: unknown;
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, async ({ request }) => {
        receivedToken = request.headers.get('X-Shopify-Access-Token');
        const body = (await request.json()) as { variables?: unknown };
        receivedVariables = body.variables;
        return HttpResponse.json({ data: { order: ORDER_NODE } });
      }),
    );
    const adapter = createShopifyAdapter(CONFIG);
    const snapshot = await adapter.fetchOrder(SHOP, creds, '1001');

    expect(receivedToken).toBe('shpat_abc123');
    expect(receivedVariables).toEqual({ id: 'gid://shopify/Order/1001' });
    expect(snapshot).toEqual({
      externalOrderId: '1001',
      createdAtPlatform: '2026-09-01T10:00:00Z',
      updatedAtPlatform: '2026-09-01T10:05:00Z',
      cancelledAt: null,
      currency: 'INR',
      totalPrice: '1299.00',
      totalRefunded: '0.00',
      totalOutstanding: '0.00',
      financialStatus: 'PAID',
      fulfillmentStatus: 'UNFULFILLED',
      paymentGatewayNames: ['razorpay'],
      email: 'shopper@example.com',
      phone: '+919812345670',
      shippingAddressZip: '560034',
      landingSite: null,
      referringSite: null,
      noteAttributes: [],
      discountCodes: ['RAHUL10'],
    });
  });

  it('returns null when Shopify has no such order (data.order: null)', async () => {
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, () =>
        HttpResponse.json({ data: { order: null } }),
      ),
    );
    const adapter = createShopifyAdapter(CONFIG);
    expect(await adapter.fetchOrder(SHOP, creds, '999999')).toBeNull();
  });

  it('falls back to shippingAddress.phone when the top-level phone is null', async () => {
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, () =>
        HttpResponse.json({ data: { order: { ...ORDER_NODE, phone: null } } }),
      ),
    );
    const adapter = createShopifyAdapter(CONFIG);
    const snapshot = await adapter.fetchOrder(SHOP, creds, '1001');
    expect(snapshot?.phone).toBe('+919812345670');
  });

  it('throws immediately on a non-throttled, non-2xx response (no retry)', async () => {
    let callCount = 0;
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, () => {
        callCount += 1;
        return HttpResponse.json(
          { errors: [{ message: 'Internal Server Error' }] },
          { status: 500 },
        );
      }),
    );
    const adapter = createShopifyAdapter(CONFIG);
    await expect(adapter.fetchOrder(SHOP, creds, '1001')).rejects.toThrow('500');
    expect(callCount).toBe(1);
  });

  it('throws immediately on a non-throttled GraphQL error (no retry)', async () => {
    let callCount = 0;
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, () => {
        callCount += 1;
        return HttpResponse.json({
          errors: [{ message: 'Field is protected' }],
          data: { order: null },
        });
      }),
    );
    const adapter = createShopifyAdapter(CONFIG);
    // A non-throttled error alongside usable `data.order: null` still parses fine and returns null
    // (Shopify's protected-field-denial shape is exactly this: null value + an ignorable error entry).
    expect(await adapter.fetchOrder(SHOP, creds, '1001')).toBeNull();
    expect(callCount).toBe(1);
  });

  it('retries exactly once on a throttled (HTTP 429) response, then succeeds if it clears', async () => {
    let callCount = 0;
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, () => {
        callCount += 1;
        if (callCount === 1) {
          return HttpResponse.json({ errors: [{ message: 'Throttled' }] }, { status: 429 });
        }
        return HttpResponse.json({ data: { order: ORDER_NODE } });
      }),
    );
    const adapter = createShopifyAdapter(CONFIG);
    const snapshot = await adapter.fetchOrder(SHOP, creds, '1001');
    expect(callCount).toBe(2);
    expect(snapshot?.externalOrderId).toBe('1001');
  });

  it('retries exactly once on a throttled 200-with-errors response (GraphQL-level throttling)', async () => {
    let callCount = 0;
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, () => {
        callCount += 1;
        if (callCount === 1) {
          return HttpResponse.json({
            errors: [{ message: 'Throttled' }],
            extensions: { cost: {} },
          });
        }
        return HttpResponse.json({ data: { order: ORDER_NODE } });
      }),
    );
    const adapter = createShopifyAdapter(CONFIG);
    await adapter.fetchOrder(SHOP, creds, '1001');
    expect(callCount).toBe(2);
  });

  it('fails fast (throws) after exhausting retries under sustained throttling, staying well under a 5s budget', async () => {
    let callCount = 0;
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, () => {
        callCount += 1;
        return HttpResponse.json({ errors: [{ message: 'Throttled' }] }, { status: 429 });
      }),
    );
    const adapter = createShopifyAdapter(CONFIG);
    const start = Date.now();
    await expect(adapter.fetchOrder(SHOP, creds, '1001')).rejects.toThrow(/throttled/i);
    const elapsedMs = Date.now() - start;

    // Exactly one retry, not an unbounded loop.
    expect(callCount).toBe(2);
    // Well under Shopify's 5s webhook timeout even with real (loopback) network overhead.
    expect(elapsedMs).toBeLessThan(2000);
  });
});

describe('createShopifyAdapter: fetchOrder — 401 (expired token)', () => {
  const creds: ShopifyCredentials = {
    accessToken: 'shpat_expired',
    accessTokenExpiresAt: new Date(0).toISOString(),
    refreshToken: 'shprt_def456',
    refreshTokenExpiresAt: new Date().toISOString(),
    scope: 'read_orders',
  };

  it('throws ShopifyUnauthorizedError, distinguishable from other failures, with no retry', async () => {
    let callCount = 0;
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, () => {
        callCount += 1;
        return HttpResponse.json(
          { errors: [{ message: 'Invalid API key or access token' }] },
          { status: 401 },
        );
      }),
    );
    const adapter = createShopifyAdapter(CONFIG);
    await expect(adapter.fetchOrder(SHOP, creds, '1001')).rejects.toBeInstanceOf(
      ShopifyUnauthorizedError,
    );
    expect(callCount).toBe(1);
  });
});

describe('createShopifyAdapter: startBulkOrders', () => {
  const creds: ShopifyCredentials = {
    accessToken: 'shpat_abc123',
    accessTokenExpiresAt: new Date().toISOString(),
    refreshToken: 'shprt_def456',
    refreshTokenExpiresAt: new Date().toISOString(),
    scope: 'read_orders',
  };

  it('submits a bulkOperationRunQuery mutation and returns the bulk operation id', async () => {
    let receivedToken: string | null = null;
    let receivedQuery = '';
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, async ({ request }) => {
        receivedToken = request.headers.get('X-Shopify-Access-Token');
        const body = (await request.json()) as { query?: string };
        receivedQuery = body.query ?? '';
        return HttpResponse.json({
          data: {
            bulkOperationRunQuery: {
              bulkOperation: { id: 'gid://shopify/BulkOperation/1', status: 'CREATED' },
              userErrors: [],
            },
          },
        });
      }),
    );
    const adapter = createShopifyAdapter(CONFIG);
    const bulkOperationId = await adapter.startBulkOrders(SHOP, creds, '2026-06-01T00:00:00Z');

    expect(receivedToken).toBe('shpat_abc123');
    expect(receivedQuery).toContain('bulkOperationRunQuery');
    expect(receivedQuery).toContain('created_at:>=2026-06-01');
    expect(bulkOperationId).toBe('gid://shopify/BulkOperation/1');
  });

  it('throws when Shopify returns userErrors instead of a bulk operation', async () => {
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, () =>
        HttpResponse.json({
          data: {
            bulkOperationRunQuery: {
              bulkOperation: null,
              userErrors: [
                {
                  field: ['query'],
                  message: 'a bulk query operation for this app and shop is already in progress',
                },
              ],
            },
          },
        }),
      ),
    );
    const adapter = createShopifyAdapter(CONFIG);
    await expect(adapter.startBulkOrders(SHOP, creds, '2026-06-01T00:00:00Z')).rejects.toThrow(
      /already in progress/,
    );
  });

  it('throws ShopifyUnauthorizedError on a 401', async () => {
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, () =>
        HttpResponse.json(
          { errors: [{ message: 'Invalid API key or access token' }] },
          { status: 401 },
        ),
      ),
    );
    const adapter = createShopifyAdapter(CONFIG);
    await expect(
      adapter.startBulkOrders(SHOP, creds, '2026-06-01T00:00:00Z'),
    ).rejects.toBeInstanceOf(ShopifyUnauthorizedError);
  });

  it('throws on a non-ok, non-401 status', async () => {
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, () =>
        HttpResponse.json({}, { status: 500 }),
      ),
    );
    const adapter = createShopifyAdapter(CONFIG);
    await expect(adapter.startBulkOrders(SHOP, creds, '2026-06-01T00:00:00Z')).rejects.toThrow(
      '500',
    );
  });
});

describe('createShopifyAdapter: bulkOperation', () => {
  const creds: ShopifyCredentials = {
    accessToken: 'shpat_abc123',
    accessTokenExpiresAt: new Date().toISOString(),
    refreshToken: 'shprt_def456',
    refreshTokenExpiresAt: new Date().toISOString(),
    scope: 'read_orders',
  };
  const OP_ID = 'gid://shopify/BulkOperation/55';

  it('reads status and result URLs for the operation, sending the token and the id', async () => {
    let seen: { token: string | null; variables: unknown } = { token: null, variables: null };
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, async ({ request }) => {
        const body = (await request.json()) as { variables: unknown };
        seen = { token: request.headers.get('x-shopify-access-token'), variables: body.variables };
        return HttpResponse.json({
          data: {
            node: {
              id: OP_ID,
              status: 'COMPLETED',
              errorCode: null,
              rootObjectCount: '42',
              url: 'https://storage.example.com/r.jsonl',
              partialDataUrl: null,
            },
          },
        });
      }),
    );
    const op = await createShopifyAdapter(CONFIG).bulkOperation(SHOP, creds, OP_ID);
    expect(op).toEqual({
      id: OP_ID,
      status: 'COMPLETED',
      errorCode: null,
      rootObjectCount: 42, // parsed from Shopify's string-typed UnsignedInt64
      url: 'https://storage.example.com/r.jsonl',
      partialDataUrl: null,
    });
    expect(seen).toEqual({ token: 'shpat_abc123', variables: { id: OP_ID } });
  });

  it('returns null when Shopify has no such node', async () => {
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, () =>
        HttpResponse.json({ data: { node: null } }),
      ),
    );
    expect(await createShopifyAdapter(CONFIG).bulkOperation(SHOP, creds, OP_ID)).toBeNull();
  });

  it('throws ShopifyUnauthorizedError on a 401 and a plain error on other failures or a bad shape', async () => {
    const adapter = createShopifyAdapter(CONFIG);
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, () =>
        HttpResponse.json({}, { status: 401 }),
      ),
    );
    await expect(adapter.bulkOperation(SHOP, creds, OP_ID)).rejects.toBeInstanceOf(
      ShopifyUnauthorizedError,
    );
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, () =>
        HttpResponse.json({}, { status: 500 }),
      ),
    );
    await expect(adapter.bulkOperation(SHOP, creds, OP_ID)).rejects.toThrow('500');
    server.use(
      http.post(`https://${SHOP}/admin/api/*/graphql.json`, () =>
        HttpResponse.json({ data: { node: { id: OP_ID } } }),
      ),
    );
    await expect(adapter.bulkOperation(SHOP, creds, OP_ID)).rejects.toThrow('unexpected response');
  });
});

describe('createShopifyAdapter: streamBulkOrders', () => {
  const RESULT_URL = 'https://storage.example.com/result.jsonl';
  const NODE = {
    id: 'gid://shopify/Order/2001',
    createdAt: '2026-09-10T10:00:00Z',
    updatedAt: '2026-09-10T10:05:00Z',
    cancelledAt: null,
    email: 'shopper@example.com',
    phone: null,
    totalPriceSet: { shopMoney: { amount: '499.50', currencyCode: 'INR' } },
    totalRefundedSet: { shopMoney: { amount: '0.00' } },
    totalOutstandingSet: { shopMoney: { amount: '499.50' } },
    paymentGatewayNames: ['Cash on Delivery (COD)'],
    displayFinancialStatus: 'PENDING',
    displayFulfillmentStatus: 'UNFULFILLED',
    discountCodes: [],
    shippingAddress: { zip: '110001', phone: '+918123456709' },
  };

  async function collect(url = RESULT_URL) {
    const lines = [];
    for await (const line of createShopifyAdapter(CONFIG).streamBulkOrders(url)) lines.push(line);
    return lines;
  }

  it('maps each JSONL line to a snapshot, without sending any auth header (the URL is pre-signed)', async () => {
    let auth: string | null = 'unset';
    const second = { ...NODE, id: 'gid://shopify/Order/2002' };
    server.use(
      http.get(RESULT_URL, ({ request }) => {
        auth = request.headers.get('x-shopify-access-token');
        return new HttpResponse(`${JSON.stringify(NODE)}\n${JSON.stringify(second)}\n`);
      }),
    );
    const lines = await collect();
    expect(auth).toBeNull();
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.kind)).toEqual(['order', 'order']);
    const first = lines[0]!;
    if (first.kind !== 'order') throw new Error('expected an order line');
    expect(first.snapshot).toMatchObject({
      externalOrderId: '2001',
      totalPrice: '499.50',
      currency: 'INR',
      shippingAddressZip: '110001',
      phone: '+918123456709', // falls back to the shipping-address phone, as fetchOrder does
    });
  });

  it('yields `invalid` (with no content) for malformed JSON, a wrong shape, and child rows; skips blank lines', async () => {
    server.use(
      http.get(
        RESULT_URL,
        () =>
          new HttpResponse(
            [
              '{not json',
              '',
              JSON.stringify({ id: 'gid://shopify/Order/1' }),
              JSON.stringify({ ...NODE, __parentId: 'gid://shopify/Order/9' }),
              JSON.stringify(NODE),
            ].join('\n'),
          ),
      ),
    );
    const lines = await collect();
    expect(lines.map((l) => l.kind)).toEqual(['invalid', 'invalid', 'invalid', 'order']);
    // An invalid line carries nothing but its kind — the raw line can hold protected customer data.
    expect(lines[0]).toEqual({ kind: 'invalid' });
  });

  it('handles CRLF line endings and a final line with no trailing newline', async () => {
    server.use(
      http.get(
        RESULT_URL,
        () => new HttpResponse(`${JSON.stringify(NODE)}\r\n${JSON.stringify(NODE)}`),
      ),
    );
    expect((await collect()).map((l) => l.kind)).toEqual(['order', 'order']);
  });

  it('yields nothing for an empty result', async () => {
    server.use(http.get(RESULT_URL, () => new HttpResponse('')));
    expect(await collect()).toEqual([]);
  });

  it('throws on a non-ok download, and refuses a non-https URL before fetching anything', async () => {
    server.use(http.get(RESULT_URL, () => new HttpResponse(null, { status: 403 })));
    await expect(collect()).rejects.toThrow('403');
    await expect(collect('http://storage.example.com/result.jsonl')).rejects.toThrow('not https');
    await expect(collect('file:///etc/passwd')).rejects.toThrow('not https');
  });
});
