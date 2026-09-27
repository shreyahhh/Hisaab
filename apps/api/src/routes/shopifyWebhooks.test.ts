import { createHmac, randomUUID } from 'node:crypto';
import { cleanupTestTenant, seedTestTenant, type TestTenant } from '@truepath/db/testing';
import { createIntegrationRepository, jobScope, schema } from '@truepath/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, testCredentialsCipher, testDb } from '../testApp.js';

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

  it('acknowledges an orders/* webhook without changing anything (M1-2/M1-3 handles these)', async () => {
    const t = await tenant('webhook-orders-noop');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    const res = await sendWebhook({
      topic: 'orders',
      shopifyTopic: 'orders/create',
      shopDomain: store!.shopDomain,
      body: { id: 1 },
    });
    expect(res.statusCode).toBe(200);
  });

  it('records exactly one delivery for a replayed orders/* webhook, even though it is a no-op today', async () => {
    const t = await tenant('webhook-orders-dedup');
    const [store] = await testDb
      .select()
      .from(schema.stores)
      .where(eq(schema.stores.id, t.storeId));
    const webhookId = randomUUID();
    const body = { id: 1 };
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
