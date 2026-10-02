import { createHmac, randomUUID } from 'node:crypto';
import { cleanupTestTenant, seedTestTenant, type TestTenant } from '@truepath/db/testing';
import { storeContext } from '@truepath/privacy';
import {
  collectorStoreKey,
  SHOPIFY_ORDER_REFRESH_DELAY_MS,
  shopifyOrderRefreshJobId,
  storeBoundScope,
  suppressionSetKey,
} from '@truepath/shared';
import { createIntegrationRepository, jobScope, schema, type Db } from '@truepath/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  testCredentialsCipher,
  testDb,
  testDsrQueue,
  testHasher,
  testIdentityStitchQueue,
  testRedis,
  testShopifySyncQueue,
} from '../testApp.js';

/** A minimal, schema-valid INR order payload (shopify-integration.md §2.5). */
function orderWebhookPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    created_at: '2026-09-01T10:00:00+05:30',
    updated_at: '2026-09-01T10:00:00+05:30',
    cancelled_at: null,
    currency: 'INR',
    total_price: '1299.00',
    financial_status: 'paid',
    fulfillment_status: null,
    payment_gateway_names: ['razorpay'],
    ...overrides,
  };
}

/**
 * Wraps `realDb` so its *first* `.update(...)` call throws instead of running — simulating a
 * handler crash mid-request, without touching `.select`/`.insert` (so store resolution and the
 * webhook-delivery dedup read/write are unaffected; only the handler's own effect fails). Every
 * subsequent `.update(...)` call behaves normally, so a retry through the same wrapped app succeeds.
 */
function dbThatFailsFirstUpdate(realDb: Db): Db {
  let updateCalls = 0;
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'update') {
        updateCalls += 1;
        if (updateCalls === 1) {
          return () => {
            throw new Error('injected failure: simulated handler crash on first delivery');
          };
        }
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Db;
}

// POST /webhooks/shopify/:topic (shopify-integration.md §2.2, §2.4, §4.2, §4.8). No session — HMAC
// + shop domain is the whole authentication story, per ADR-0024/the CSRF-hook exemption.

const CLIENT_SECRET = 'test-client-secret'; // matches testApp.ts's testShopifyAdapter config
const app = buildTestApp();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function tenant(label: string): Promise<TestTenant> {
  const t = await seedTestTenant(label);
  cleanups.push(() => cleanupTestTenant(t));
  return t;
}

function sign(body: string): string {
  return createHmac('sha256', CLIENT_SECRET).update(body).digest('base64');
}

interface WebhookRequest {
  readonly topic: string; // path segment: orders | order-hints | app | compliance
  readonly shopifyTopic: string;
  readonly shopDomain: string;
  readonly body: unknown;
  readonly webhookId?: string;
  readonly badHmac?: boolean;
}

async function sendWebhook(req: WebhookRequest) {
  const payload = JSON.stringify(req.body);
  const hmac = req.badHmac ? 'not-a-valid-signature==' : sign(payload);
  return app.inject({
    method: 'POST',
    url: `/webhooks/shopify/${req.topic}`,
    payload,
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': hmac,
      'x-shopify-shop-domain': req.shopDomain,
      'x-shopify-topic': req.shopifyTopic,
      'x-shopify-webhook-id': req.webhookId ?? randomUUID(),
    },
  });
}

describe('POST /webhooks/shopify/:topic — HMAC and shop resolution', () => {
  it('rejects a bad HMAC signature with 401', async () => {
    const t = await tenant('webhook-bad-hmac');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    const res = await sendWebhook({
      topic: 'app',
      shopifyTopic: 'app/uninstalled',
      shopDomain: store!.shopDomain,
      body: {},
      badHmac: true,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 and does nothing for an unknown shop domain', async () => {
    const res = await sendWebhook({
      topic: 'app',
      shopifyTopic: 'app/uninstalled',
      shopDomain: 'no-such-shop.myshopify.com',
      body: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 when required headers are missing', async () => {
    const payload = JSON.stringify({});
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/shopify/app',
      payload,
      headers: { 'content-type': 'application/json', 'x-shopify-hmac-sha256': sign(payload) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 and does nothing when X-Shopify-Topic does not belong to the :topic group', async () => {
    const t = await tenant('webhook-topic-mismatch');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    const res = await sendWebhook({
      topic: 'orders', // wrong group for app/uninstalled
      shopifyTopic: 'app/uninstalled',
      shopDomain: store!.shopDomain,
      body: {},
    });
    expect(res.statusCode).toBe(200);
    const [row] = await testDb.select().from(schema.stores).where(eq(schema.stores.id, t.storeId));
    expect(row?.status).not.toBe('uninstalled');
  });

  it('acknowledges a valid orders/create webhook with 200', async () => {
    const t = await tenant('webhook-orders-ack');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    const res = await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/create',
      shopDomain: store!.shopDomain,
      body: orderWebhookPayload(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('records exactly one delivery for a replayed orders/* webhook', async () => {
    const t = await tenant('webhook-orders-dedup');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    const webhookId = randomUUID();
    const body = orderWebhookPayload();
    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/create',
      shopDomain: store!.shopDomain,
      webhookId,
      body,
    });
    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/create',
      shopDomain: store!.shopDomain,
      webhookId,
      body,
    });
    const deliveries = await testDb
      .select()
      .from(schema.shopifyWebhookDeliveries)
      .where(eq(schema.shopifyWebhookDeliveries.storeId, t.storeId));
    expect(deliveries).toHaveLength(1);
  });
});

describe('POST /webhooks/shopify/app — app/uninstalled', () => {
  it('marks the store uninstalled, revokes the integration, and audits integration_disconnected', async () => {
    const t = await tenant('webhook-uninstall');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    const integration = await createIntegrationRepository(testDb).upsertShopify(
      jobScope(t.organizationId, t.storeId),
      {
        storeId: t.storeId,
        externalAccountId: 'gid://shopify/Shop/uninstall-test',
        credentialsJson: '{"accessToken":"shpat_x"}',
        scopes: ['read_orders'],
        cipher: testCredentialsCipher,
      },
    );

    const res = await sendWebhook({
      topic: 'app',
      shopifyTopic: 'app/uninstalled',
      shopDomain: store!.shopDomain,
      body: { id: 1 },
    });
    expect(res.statusCode).toBe(200);

    const [updatedStore] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    expect(updatedStore?.status).toBe('uninstalled');

    const [updatedIntegration] = await testDb
      .select()
      .from(schema.integrations)
      .where(eq(schema.integrations.id, integration.id));
    expect(updatedIntegration?.status).toBe('revoked');
    expect(updatedIntegration?.encryptedCredentials).toBeNull();

    const auditRows = await testDb
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, integration.id));
    expect(auditRows.some((r) => r.action === 'integration_disconnected')).toBe(true);
  });

  it('deletes the collector:store:<store_key> config so the signing secret does not outlive the integration (issue #44)', async () => {
    const t = await tenant('webhook-uninstall-collector-config');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    await createIntegrationRepository(testDb).upsertShopify(jobScope(t.organizationId, t.storeId), {
      storeId: t.storeId,
      externalAccountId: 'gid://shopify/Shop/uninstall-config',
      credentialsJson: '{"accessToken":"shpat_x"}',
      scopes: ['read_orders'],
      cipher: testCredentialsCipher,
    });
    const storeKey = 'pk_' + 'a'.repeat(24);
    await createIntegrationRepository(testDb).patchShopifySettings(
      jobScope(t.organizationId, t.storeId),
      t.storeId,
      { store_key: storeKey },
    );
    const key = collectorStoreKey(storeKey);
    await testRedis.set(key, JSON.stringify({ storeId: t.storeId, status: 'active' }));
    cleanups.push(async () => void (await testRedis.del(key)));

    const res = await sendWebhook({
      topic: 'app',
      shopifyTopic: 'app/uninstalled',
      shopDomain: store!.shopDomain,
      body: { id: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(await testRedis.get(key)).toBeNull();
  });

  it('is idempotent: a retried webhook does not write a second audit row', async () => {
    const t = await tenant('webhook-uninstall-retry');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    await createIntegrationRepository(testDb).upsertShopify(jobScope(t.organizationId, t.storeId), {
      storeId: t.storeId,
      externalAccountId: 'gid://shopify/Shop/uninstall-retry',
      credentialsJson: '{}',
      scopes: [],
      cipher: testCredentialsCipher,
    });

    const body = { id: 1 };
    await sendWebhook({
      topic: 'app',
      shopifyTopic: 'app/uninstalled',
      shopDomain: store!.shopDomain,
      body,
    });
    const retry = await sendWebhook({
      topic: 'app',
      shopifyTopic: 'app/uninstalled',
      shopDomain: store!.shopDomain,
      body,
    });
    expect(retry.statusCode).toBe(200);

    const auditRows = await testDb
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.organizationId, t.organizationId));
    expect(auditRows.filter((r) => r.action === 'integration_disconnected')).toHaveLength(1);
  });

  it('a replayed X-Shopify-Webhook-Id is a true dedup no-op, not just state-based idempotency', async () => {
    const t = await tenant('webhook-uninstall-dedup-not-state');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    const webhookId = randomUUID();
    const body = { id: 1 };

    const first = await sendWebhook({
      topic: 'app',
      shopifyTopic: 'app/uninstalled',
      shopDomain: store!.shopDomain,
      webhookId,
      body,
    });
    expect(first.statusCode).toBe(200);

    // Reactivate the store by hand — if the route only relied on state-based idempotency
    // (delivery_status/status != 'uninstalled' guards), a replay would re-run the handler and
    // re-uninstall it. It must not: the delivery record itself, not store state, is what stops it.
    await testDb
      .update(schema.stores)
      .set({ status: 'active' })
      .where(eq(schema.stores.id, t.storeId));

    const replay = await sendWebhook({
      topic: 'app',
      shopifyTopic: 'app/uninstalled',
      shopDomain: store!.shopDomain,
      webhookId,
      body,
    });
    expect(replay.statusCode).toBe(200);

    const [afterReplay] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    expect(afterReplay?.status).toBe('active'); // untouched by the replay

    const deliveries = await testDb
      .select()
      .from(schema.shopifyWebhookDeliveries)
      .where(eq(schema.shopifyWebhookDeliveries.storeId, t.storeId));
    expect(deliveries).toHaveLength(1);
  });

  it('a handler failure on the first delivery does not mark it delivered — a retry with the same webhook id completes it', async () => {
    const t = await tenant('webhook-uninstall-handler-fails-once');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    const integration = await createIntegrationRepository(testDb).upsertShopify(
      jobScope(t.organizationId, t.storeId),
      {
        storeId: t.storeId,
        externalAccountId: 'gid://shopify/Shop/handler-fails-once',
        credentialsJson: '{}',
        scopes: [],
        cipher: testCredentialsCipher,
      },
    );

    const flakyApp = buildTestApp({ db: dbThatFailsFirstUpdate(testDb) });
    try {
      const webhookId = randomUUID();
      const payload = JSON.stringify({ id: 1 });
      const send = () =>
        flakyApp.inject({
          method: 'POST',
          url: '/webhooks/shopify/app',
          payload,
          headers: {
            'content-type': 'application/json',
            'x-shopify-hmac-sha256': sign(payload),
            'x-shopify-shop-domain': store!.shopDomain,
            'x-shopify-topic': 'app/uninstalled',
            'x-shopify-webhook-id': webhookId,
          },
        });

      // Attempt 1: the handler's own DB update throws — Shopify would see a 5xx and retry.
      const first = await send();
      expect(first.statusCode).toBe(500);

      // Nothing was recorded as delivered, and the store must still be untouched by the failed attempt.
      const [afterFailure] = await testDb
        .select()
        .from(schema.stores)
        .where(eq(schema.stores.id, t.storeId));
      expect(afterFailure?.status).not.toBe('uninstalled');
      const deliveriesAfterFailure = await testDb
        .select()
        .from(schema.shopifyWebhookDeliveries)
        .where(eq(schema.shopifyWebhookDeliveries.storeId, t.storeId));
      expect(deliveriesAfterFailure).toHaveLength(0);

      // Attempt 2 (Shopify's retry, same X-Shopify-Webhook-Id): the update no longer throws, so the
      // handler completes and the delivery is finally recorded.
      const retry = await send();
      expect(retry.statusCode).toBe(200);

      const [afterRetry] = await testDb
        .select()
        .from(schema.stores)
        .where(eq(schema.stores.id, t.storeId));
      expect(afterRetry?.status).toBe('uninstalled');

      const [updatedIntegration] = await testDb
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.id, integration.id));
      expect(updatedIntegration?.status).toBe('revoked');
      expect(updatedIntegration?.encryptedCredentials).toBeNull();

      const deliveriesAfterRetry = await testDb
        .select()
        .from(schema.shopifyWebhookDeliveries)
        .where(eq(schema.shopifyWebhookDeliveries.storeId, t.storeId));
      expect(deliveriesAfterRetry).toHaveLength(1);
    } finally {
      await flakyApp.close();
    }
  });
});

describe('POST /webhooks/shopify/compliance', () => {
  it('customers/data_request creates a dsr_requests(type=access) receipt with a hashed identity, and audits dsr_created', async () => {
    const t = await tenant('webhook-data-request');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    const webhookId = randomUUID();
    const res = await sendWebhook({
      topic: 'compliance',
      shopifyTopic: 'customers/data_request',
      shopDomain: store!.shopDomain,
      webhookId,
      body: {
        shop_id: 1,
        shop_domain: store!.shopDomain,
        customer: { id: 1, email: 'shopper@example.com' },
      },
    });
    expect(res.statusCode).toBe(200);

    const rows = await testDb
      .select()
      .from(schema.dsrRequests)
      .where(eq(schema.dsrRequests.storeId, t.storeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('access');
    expect(rows[0]?.identityHash).not.toBeNull();
    expect(rows[0]?.identityHash).not.toContain('shopper@example.com');
    expect((rows[0]?.resultSummary as Record<string, unknown>).source_ref).toBe(webhookId);

    const auditRows = await testDb
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, rows[0]!.id));
    expect(auditRows[0]?.action).toBe('dsr_created');

    // `access` has no fulfilment pipeline yet (SPEC v0.5: needs an S3 export bucket) — no job enqueued.
    expect(await testDsrQueue.getJob(`dsr-${rows[0]!.id}`)).toBeUndefined();
  });

  it('customers/redact creates a dsr_requests(type=erasure) receipt', async () => {
    const t = await tenant('webhook-redact');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    await sendWebhook({
      topic: 'compliance',
      shopifyTopic: 'customers/redact',
      shopDomain: store!.shopDomain,
      // Not a sequential/dummy number (privacy-dpdp.md §4.1's blocklist would zero out 9876543210).
      body: {
        shop_id: 1,
        shop_domain: store!.shopDomain,
        customer: { id: 1, phone: '+919812345670' },
      },
    });
    const rows = await testDb
      .select()
      .from(schema.dsrRequests)
      .where(eq(schema.dsrRequests.storeId, t.storeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('erasure');
    expect(rows[0]?.identityHash).not.toBeNull();

    const job = await testDsrQueue.getJob(`dsr-${rows[0]!.id}`);
    expect(job?.data).toMatchObject({
      storeId: t.storeId,
      type: 'erasure',
      requestId: rows[0]!.id,
    });
  });

  it('shop/redact creates a dsr_requests(type=store_erasure) receipt with a null identity hash', async () => {
    const t = await tenant('webhook-shop-redact');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    await sendWebhook({
      topic: 'compliance',
      shopifyTopic: 'shop/redact',
      shopDomain: store!.shopDomain,
      body: { shop_id: 1, shop_domain: store!.shopDomain },
    });
    const rows = await testDb
      .select()
      .from(schema.dsrRequests)
      .where(eq(schema.dsrRequests.storeId, t.storeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('store_erasure');
    expect(rows[0]?.identityHash).toBeNull();

    // Delayed 7 days (privacy-dpdp.md §4.7 step 2) — keeps the export window open.
    const job = await testDsrQueue.getJob(`dsr-${rows[0]!.id}`);
    expect(job?.data).toMatchObject({
      storeId: t.storeId,
      type: 'store_erasure',
      requestId: rows[0]!.id,
    });
    expect(job?.opts.delay).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('is idempotent: a retried compliance webhook (same X-Shopify-Webhook-Id) creates only one receipt', async () => {
    const t = await tenant('webhook-compliance-dedupe');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    const webhookId = randomUUID();
    const body = { shop_id: 1, shop_domain: store!.shopDomain };
    await sendWebhook({
      topic: 'compliance',
      shopifyTopic: 'shop/redact',
      shopDomain: store!.shopDomain,
      webhookId,
      body,
    });
    await sendWebhook({
      topic: 'compliance',
      shopifyTopic: 'shop/redact',
      shopDomain: store!.shopDomain,
      webhookId,
      body,
    });

    const rows = await testDb
      .select()
      .from(schema.dsrRequests)
      .where(eq(schema.dsrRequests.storeId, t.storeId));
    expect(rows).toHaveLength(1);
  });

  it('never persists or logs the raw customer email/phone (SPEC §5.4)', async () => {
    const t = await tenant('webhook-no-raw-pii');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    await sendWebhook({
      topic: 'compliance',
      shopifyTopic: 'customers/redact',
      shopDomain: store!.shopDomain,
      body: {
        shop_id: 1,
        shop_domain: store!.shopDomain,
        customer: { id: 1, email: 'no-raw-pii@example.com' },
      },
    });
    const rows = await testDb
      .select()
      .from(schema.dsrRequests)
      .where(eq(schema.dsrRequests.storeId, t.storeId));
    expect(JSON.stringify(rows)).not.toContain('no-raw-pii@example.com');
  });
});

describe('CSRF-hook exemption stays scoped to /webhooks/ (app.ts)', () => {
  it("does not extend to a lookalike path that merely starts with 'webhooks'", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooksevil',
      payload: '{}',
      headers: { 'content-type': 'application/json' }, // no Origin — would be rejected if the hook applies
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'invalid_origin' });
  });

  it('a real webhook delivery needs no Origin header at all (the exemption is real)', async () => {
    const t = await tenant('webhook-no-origin-needed');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    const payload = JSON.stringify({ id: 1 });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/shopify/orders',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': sign(payload),
        'x-shopify-shop-domain': store!.shopDomain,
        'x-shopify-topic': 'orders/create',
        'x-shopify-webhook-id': randomUUID(),
        // deliberately no origin header
      },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /webhooks/shopify/orders — real snapshot apply (M1-2)', () => {
  it('orders/create stores the order with hashed identity and parsed money', async () => {
    const t = await tenant('webhook-orders-create-real');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/create',
      shopDomain: store!.shopDomain,
      body: orderWebhookPayload({
        email: 'shopper@example.com',
        phone: '+919812345670',
        shipping_address: { zip: '560034', phone: '+919812345670' },
      }),
    });

    const rows = await testDb
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.storeId, t.storeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totalAmountPaise).toBe(129900);
    expect(rows[0]?.pincodePrefix).toBe('560');
    expect(rows[0]?.phoneHashHmac).toMatch(/^k\d+:[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain('shopper@example.com');
  });

  it('orders/updated updates the existing order rather than creating a second one', async () => {
    const t = await tenant('webhook-orders-update-real');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/create',
      shopDomain: store!.shopDomain,
      body: orderWebhookPayload({ financial_status: 'pending' }),
    });
    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/updated',
      shopDomain: store!.shopDomain,
      body: orderWebhookPayload({
        financial_status: 'paid',
        updated_at: '2026-09-01T11:00:00+05:30',
      }),
    });

    const rows = await testDb
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.storeId, t.storeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.financialStatus).toBe('paid');
  });

  it('orders/cancelled cancels a pending order', async () => {
    const t = await tenant('webhook-orders-cancel-real');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/create',
      shopDomain: store!.shopDomain,
      body: orderWebhookPayload(),
    });
    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/cancelled',
      shopDomain: store!.shopDomain,
      body: orderWebhookPayload({
        cancelled_at: '2026-09-01T11:00:00+05:30',
        updated_at: '2026-09-01T11:00:00+05:30',
      }),
    });
    const [row] = await testDb
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.storeId, t.storeId));
    expect(row?.deliveryStatus).toBe('cancelled');
  });

  it('a stale (older) orders/updated does not overwrite newer state', async () => {
    const t = await tenant('webhook-orders-stale-real');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/updated',
      shopDomain: store!.shopDomain,
      body: orderWebhookPayload({
        financial_status: 'paid',
        updated_at: '2026-09-01T12:00:00+05:30',
      }),
    });
    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/updated',
      shopDomain: store!.shopDomain,
      body: orderWebhookPayload({
        financial_status: 'pending',
        updated_at: '2026-09-01T09:00:00+05:30',
      }),
    });
    const [row] = await testDb
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.storeId, t.storeId));
    expect(row?.financialStatus).toBe('paid');
  });
});

describe('POST /webhooks/shopify/orders — non-INR currency (M1-2 review item 5)', () => {
  it('skips storing a non-INR order rather than converting it to a wrong paise value', async () => {
    const t = await tenant('webhook-orders-non-inr');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    const res = await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/create',
      shopDomain: store!.shopDomain,
      body: orderWebhookPayload({ currency: 'USD', total_price: '50.00' }),
    });
    expect(res.statusCode).toBe(200); // acknowledged — retrying wouldn't change the currency

    const rows = await testDb
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.storeId, t.storeId));
    expect(rows).toHaveLength(0);
  });

  it('still processes a subsequent INR order for the same store normally', async () => {
    const t = await tenant('webhook-orders-non-inr-then-inr');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/create',
      shopDomain: store!.shopDomain,
      body: orderWebhookPayload({ id: 2001, currency: 'USD', total_price: '50.00' }),
    });
    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/create',
      shopDomain: store!.shopDomain,
      body: orderWebhookPayload({ id: 2002, currency: 'INR' }),
    });
    const rows = await testDb
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.storeId, t.storeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalOrderId).toBe('2002');
  });
});

describe('POST /webhooks/shopify/orders — validation failures log field paths only (M1-2 review item 6)', () => {
  it('logs only field paths, never the received value, for an invalid payload', async () => {
    const t = await tenant('webhook-orders-validation-log');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    const poisonValue = 'super-secret-poison-value-should-never-be-logged';
    const originalConsoleError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '));
    try {
      const res = await sendWebhook({
        topic: 'orders',
        shopifyTopic: 'orders/create',
        shopDomain: store!.shopDomain,
        body: orderWebhookPayload({ total_price: poisonValue }), // fails the money-string regex
      });
      expect(res.statusCode).toBe(200); // ack — malformed payloads aren't retried
    } finally {
      console.error = originalConsoleError;
    }
    const combined = logged.join('\n');
    expect(combined).not.toContain(poisonValue);
    expect(combined).toContain('total_price'); // the field path is exactly what should be logged

    const rows = await testDb
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.storeId, t.storeId));
    expect(rows).toHaveLength(0);
  });

  it('never crashes on non-JSON body — logs and acks instead', async () => {
    const t = await tenant('webhook-orders-bad-json');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    const payload = 'not valid json {{{';
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/shopify/orders',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': sign(payload),
        'x-shopify-shop-domain': store!.shopDomain,
        'x-shopify-topic': 'orders/create',
        'x-shopify-webhook-id': randomUUID(),
      },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /webhooks/shopify/order-hints — refunds/fulfillments (issue #41)', () => {
  // Issue #41: these hints no longer call `fetchOrder` synchronously (M1-2's original approach) —
  // they enqueue a debounced `order_refresh` job and return. The worker-side apply (including the
  // out-of-order-delivery and "Shopify has no such order" cases) is covered by
  // `apps/workers/src/shopifySync.test.ts`'s `order_refresh` suite.
  async function storeDomain(label: string) {
    const t = await tenant(label);
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    return { t, shopDomain: store!.shopDomain };
  }

  // Mirrors the `bulk_operations/finish` describe block below: the real local queue, cleaned up so a
  // worker running against the same Redis never picks up a leftover test job.
  async function jobFor(storeId: string, externalOrderId: string) {
    const job = await testShopifySyncQueue.getJob(shopifyOrderRefreshJobId(storeId, externalOrderId));
    if (job) cleanups.push(async () => void (await job.remove().catch(() => undefined)));
    return job;
  }

  it('refunds/create enqueues a debounced order_refresh job, tied to the store and order', async () => {
    const { t, shopDomain } = await storeDomain('webhook-refund-hint');
    const res = await sendWebhook({
      topic: 'order-hints',
      shopifyTopic: 'refunds/create',
      shopDomain,
      body: { order_id: 1001, created_at: '2026-09-01T11:00:00Z' },
    });
    expect(res.statusCode).toBe(200);

    const job = await jobFor(t.storeId, '1001');
    expect(job?.data).toEqual({
      storeId: t.storeId,
      mode: 'order_refresh',
      externalOrderIds: ['1001'],
    });
    expect(job?.opts.delay).toBe(SHOPIFY_ORDER_REFRESH_DELAY_MS);
    expect(job?.opts.removeOnComplete).toBe(true);
    // Nothing is applied synchronously — that's the worker's job once the debounce elapses.
    expect(
      await testDb.select().from(schema.orders).where(eq(schema.orders.storeId, t.storeId)),
    ).toHaveLength(0);
  });

  it('collapses a burst of hints for the same order into one debounced job', async () => {
    const { t, shopDomain } = await storeDomain('webhook-hint-burst');
    for (const shopifyTopic of ['refunds/create', 'fulfillments/create', 'fulfillments/update']) {
      const res = await sendWebhook({
        topic: 'order-hints',
        shopifyTopic,
        shopDomain,
        body: { order_id: 2002 },
      });
      expect(res.statusCode).toBe(200);
    }
    const jobs = await testShopifySyncQueue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
      'failed',
    ]);
    const matching = jobs.filter(
      (j) => j.data.storeId === t.storeId && j.data.externalOrderIds?.[0] === '2002',
    );
    expect(matching).toHaveLength(1);
    await jobFor(t.storeId, '2002');
  });

  it('a numeric and a string order_id for the same order collapse into the same job id', async () => {
    const { t, shopDomain } = await storeDomain('webhook-hint-id-shapes');
    await sendWebhook({
      topic: 'order-hints',
      shopifyTopic: 'refunds/create',
      shopDomain,
      body: { order_id: 3003 },
    });
    await sendWebhook({
      topic: 'order-hints',
      shopifyTopic: 'fulfillments/create',
      shopDomain,
      body: { order_id: '3003' },
    });
    const jobs = await testShopifySyncQueue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.filter((j) => j.data.storeId === t.storeId)).toHaveLength(1);
    await jobFor(t.storeId, '3003');
  });

  it('acks and enqueues nothing for a malformed payload', async () => {
    const { t, shopDomain } = await storeDomain('webhook-hint-malformed');
    const res = await sendWebhook({
      topic: 'order-hints',
      shopifyTopic: 'refunds/create',
      shopDomain,
      body: { not_an_order_id: true },
    });
    expect(res.statusCode).toBe(200);
    const jobs = await testShopifySyncQueue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.filter((j) => j.data.storeId === t.storeId)).toHaveLength(0);
  });
});

describe('POST /webhooks/shopify/app — bulk_operations/finish (M1-3b)', () => {
  const opGid = () => `gid://shopify/BulkOperation/${Math.floor(Math.random() * 1e12)}`;

  async function storeDomain(label: string) {
    const t = await tenant(label);
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    return { t, shopDomain: store!.shopDomain };
  }

  // The queue is the real local one — remove what a test enqueues so a worker running against the
  // same Redis never picks up a leftover test job.
  async function jobFor(gid: string) {
    const job = await testShopifySyncQueue.getJob(`bulk-result-${gid.split('/').pop()}`);
    if (job) cleanups.push(async () => void (await job.remove().catch(() => undefined)));
    return job;
  }

  it('enqueues a bulk_result job for a finished query operation, tied to the store and operation id', async () => {
    const { t, shopDomain } = await storeDomain('webhook-bulk-finish');
    const gid = opGid();
    const res = await sendWebhook({
      topic: 'app',
      shopifyTopic: 'bulk_operations/finish',
      shopDomain,
      body: {
        admin_graphql_api_id: gid,
        type: 'query',
        status: 'completed',
        completed_at: '2026-09-28T09:00:00Z',
      },
    });
    expect(res.statusCode).toBe(200);
    const job = await jobFor(gid);
    expect(job?.data).toEqual({ storeId: t.storeId, mode: 'bulk_result', bulkOperationId: gid });
  });

  it('also enqueues for a failed operation — the worker re-reads the status and records the failure', async () => {
    const { t, shopDomain } = await storeDomain('webhook-bulk-failed');
    const gid = opGid();
    const res = await sendWebhook({
      topic: 'app',
      shopifyTopic: 'bulk_operations/finish',
      shopDomain,
      body: {
        admin_graphql_api_id: gid,
        type: 'query',
        status: 'failed',
        error_code: 'ACCESS_DENIED',
      },
    });
    expect(res.statusCode).toBe(200);
    expect((await jobFor(gid))?.data.storeId).toBe(t.storeId);
  });

  it('collapses a redelivery (a different webhook id for the same operation) into the one job', async () => {
    const { shopDomain } = await storeDomain('webhook-bulk-redelivery');
    const gid = opGid();
    for (const webhookId of [randomUUID(), randomUUID()]) {
      const res = await sendWebhook({
        topic: 'app',
        shopifyTopic: 'bulk_operations/finish',
        shopDomain,
        webhookId,
        body: { admin_graphql_api_id: gid, type: 'query', status: 'completed' },
      });
      expect(res.statusCode).toBe(200);
    }
    const jobs = await testShopifySyncQueue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
      'failed',
    ]);
    const matching = jobs.filter((j) => j.data.bulkOperationId === gid);
    expect(matching).toHaveLength(1);
    await jobFor(gid);
  });

  it('ignores mutation-type operations (not ours)', async () => {
    const { shopDomain } = await storeDomain('webhook-bulk-mutation');
    const gid = opGid();
    const res = await sendWebhook({
      topic: 'app',
      shopifyTopic: 'bulk_operations/finish',
      shopDomain,
      body: { admin_graphql_api_id: gid, type: 'mutation', status: 'completed' },
    });
    expect(res.statusCode).toBe(200);
    expect(await jobFor(gid)).toBeUndefined();
  });

  it('acks a malformed payload without enqueueing, logging field paths only', async () => {
    const { shopDomain } = await storeDomain('webhook-bulk-malformed');
    const poison = 'poison-value-never-logged';
    const original = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '));
    try {
      const res = await sendWebhook({
        topic: 'app',
        shopifyTopic: 'bulk_operations/finish',
        shopDomain,
        body: { admin_graphql_api_id: 12345, type: poison, status: 'completed' },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      console.error = original;
    }
    const combined = logged.join('\n');
    expect(combined).not.toContain(poison);
    expect(combined).toContain('admin_graphql_api_id');
    expect(await jobFor('12345')).toBeUndefined();
  });

  it('does not enqueue for a bulk-finish webhook from an unknown shop', async () => {
    const gid = opGid();
    const res = await sendWebhook({
      topic: 'app',
      shopifyTopic: 'bulk_operations/finish',
      shopDomain: 'no-such-shop-anywhere.myshopify.com',
      body: { admin_graphql_api_id: gid, type: 'query', status: 'completed' },
    });
    expect(res.statusCode).toBe(200);
    expect(await jobFor(gid)).toBeUndefined();
  });
});

describe('orders → identity-stitch (M1-7, identity-stitching.md §2.1) and erased identities (HLD §6b)', () => {
  async function shopDomainOf(t: TestTenant): Promise<string> {
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    return store!.shopDomain;
  }
  async function ordersOf(t: TestTenant) {
    return testDb.select().from(schema.orders).where(eq(schema.orders.storeId, t.storeId));
  }
  async function onlyOrder(t: TestTenant) {
    const rows = await ordersOf(t);
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }
  /** The attempt-0 job for an order, removed after the test so the shared queue stays clean. */
  async function stitchJob(orderId: string) {
    const job = await testIdentityStitchQueue.getJob(`stitch:${orderId}:0`);
    if (job) cleanups.push(async () => void (await job.remove().catch(() => undefined)));
    return job;
  }
  async function markErased(t: TestTenant, hash: string) {
    const key = suppressionSetKey(storeBoundScope(t.storeId), t.storeId, 'erased:identity');
    await testRedis.zadd(key, Math.floor(Date.now() / 1000) + 10_000, hash);
    cleanups.push(async () => void (await testRedis.del(key)));
  }
  const HASH_SHAPE = /^k\d+:[0-9a-f]{64}$/;

  it('orders/create enqueues attempt 0 for the stored order, with the LLD job id and retry policy', async () => {
    const t = await tenant('webhook-stitch-create');
    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/create',
      shopDomain: await shopDomainOf(t),
      body: orderWebhookPayload({ phone: '+919812345671' }),
    });
    const order = await onlyOrder(t);
    const job = await stitchJob(order.id);
    expect(job?.data).toEqual({ storeId: t.storeId, orderId: order.id, attempt: 0 });
    expect(job?.opts.attempts).toBe(5);
    expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 2000 });
  });

  it('a later orders/updated for the same order does not create a second job (the job id is the key)', async () => {
    const t = await tenant('webhook-stitch-dedupe');
    const shopDomain = await shopDomainOf(t);
    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/create',
      shopDomain,
      body: orderWebhookPayload(),
    });
    const order = await onlyOrder(t);
    await stitchJob(order.id);
    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/updated',
      shopDomain,
      body: orderWebhookPayload({ updated_at: '2026-09-01T11:00:00+05:30' }),
    });
    const jobs = await testIdentityStitchQueue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
    ]);
    expect(jobs.filter((j) => j.data.orderId === order.id)).toHaveLength(1);
  });

  it('a non-INR order is skipped: nothing stored, nothing enqueued', async () => {
    const t = await tenant('webhook-stitch-non-inr');
    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/create',
      shopDomain: await shopDomainOf(t),
      body: orderWebhookPayload({ currency: 'USD' }),
    });
    expect(await ordersOf(t)).toEqual([]);
  });

  it("stores an erased shopper's order without their hashes, still enqueues the stitch, and keeps the revenue", async () => {
    const t = await tenant('webhook-erased-identity');
    const phone = '+919812345672';
    await markErased(t, testHasher.hashPhone(storeContext(t.storeId), phone)!);

    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/create',
      shopDomain: await shopDomainOf(t),
      body: orderWebhookPayload({ phone, email: 'erased@example.com' }),
    });
    const order = await onlyOrder(t);
    expect(order.phoneHashHmac).toBeNull();
    expect(order.emailHashHmac).toBeNull();
    expect(order.totalAmountPaise).toBe(129900); // the sale still counts, as Unattributed
    expect((await stitchJob(order.id))?.data.attempt).toBe(0); // the stitcher then skips it as anonymised
  });

  it('an erased email alone is enough, and another shopper of the same store is unaffected', async () => {
    const t = await tenant('webhook-erased-email');
    const email = 'gone@example.com';
    await markErased(t, testHasher.hashEmail(storeContext(t.storeId), email)!);
    const shopDomain = await shopDomainOf(t);

    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/create',
      shopDomain,
      body: orderWebhookPayload({ id: 3001, email }),
    });
    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/create',
      shopDomain,
      body: orderWebhookPayload({ id: 3002, email: 'kept@example.com' }),
    });
    const byId = new Map((await ordersOf(t)).map((r) => [r.externalOrderId, r]));
    expect(byId.get('3001')?.emailHashHmac).toBeNull();
    expect(byId.get('3002')?.emailHashHmac).toMatch(HASH_SHAPE);
  });

  it("an erased identity in another store does not anonymise this store's order", async () => {
    const t = await tenant('webhook-erased-own');
    const other = await tenant('webhook-erased-other');
    const phone = '+919812345673';
    await markErased(other, testHasher.hashPhone(storeContext(other.storeId), phone)!);

    await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/create',
      shopDomain: await shopDomainOf(t),
      body: orderWebhookPayload({ phone }),
    });
    expect((await onlyOrder(t)).phoneHashHmac).toMatch(HASH_SHAPE);
  });
});
