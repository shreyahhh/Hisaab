import { eq } from 'drizzle-orm';
import { resolveMembership } from '@truepath/auth';
import { schema } from '@truepath/db';
import type { ShopifyAdapter, ShopifyCredentials, ShopifyShopInfo } from '@truepath/integrations';
import { afterEach, describe, expect, it } from 'vitest';
import { issueShopifyOAuthState } from '../shopifyOAuthState.js';
import {
  buildTestApp,
  testCredentialsCipher,
  testDb,
  testHasher,
  testRedis,
  TEST_DASHBOARD_URL,
  TEST_SHOPIFY_OAUTH_STATE_SECRET,
  testAuth,
} from '../testApp.js';
import {
  addRealMember,
  cleanupRealMember,
  cleanupRealTenant,
  seedRealTenant,
  type RealTenant,
} from '../testAuthTenant.js';

// GET /v1/orgs/:id/integrations/shopify/connect, GET /v1/integrations/shopify/callback,
// DELETE /v1/orgs/:id/integrations/:integrationId (ADR-0024, ADR-0025, shopify-integration.md §4.1).
// Real Postgres, real Redis, real Better Auth sessions — only the Shopify HTTP calls are faked, since
// the adapter's own HTTP behaviour is unit-tested in packages/integrations.

const ORIGIN = 'http://localhost:5173';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function tenant(label: string): Promise<RealTenant> {
  const t = await seedRealTenant(testAuth, testDb, label);
  cleanups.push(() => cleanupRealTenant(testDb, t));
  return t;
}

const DEFAULT_CREDENTIALS: ShopifyCredentials = {
  accessToken: 'shpat_test',
  accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  refreshToken: 'shprt_test',
  refreshTokenExpiresAt: new Date(Date.now() + 7_776_000_000).toISOString(),
  scope: 'read_orders,write_pixels,read_customer_events',
};

interface FakeAdapterOptions {
  readonly credentials?: ShopifyCredentials;
  readonly shopInfoResult?: ShopifyShopInfo;
  readonly exchangeCodeError?: boolean;
  readonly shopInfoError?: boolean;
}

function fakeShopifyAdapter(options: FakeAdapterOptions = {}): ShopifyAdapter {
  return {
    provider: 'shopify',
    authUrl: (shop, state, redirectUri) =>
      `https://${shop}/admin/oauth/authorize?client_id=test&scope=read_orders&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    async exchangeCode() {
      if (options.exchangeCodeError) throw new Error('exchange failed');
      return options.credentials ?? DEFAULT_CREDENTIALS;
    },
    async refresh(_shop, creds) {
      return creds;
    },
    async shopInfo(shop) {
      if (options.shopInfoError) throw new Error('shopInfo failed');
      return (
        options.shopInfoResult ?? {
          gid: `gid://shopify/Shop/${shop}`,
          myshopifyDomain: shop,
          currency: 'INR',
        }
      );
    },
    async healthCheck() {
      return { healthy: true };
    },
    verifyWebhook: () => true,
  };
}

function appWith(adapterOptions: FakeAdapterOptions = {}) {
  return buildTestApp({
    shopify: {
      adapter: fakeShopifyAdapter(adapterOptions),
      cipher: testCredentialsCipher,
      hasher: testHasher,
      redis: testRedis,
      oauthStateSecret: TEST_SHOPIFY_OAUTH_STATE_SECRET,
      appUrl: 'http://localhost:3000',
      dashboardUrl: TEST_DASHBOARD_URL,
    },
  });
}

async function issueState(t: RealTenant, shop: string): Promise<string> {
  return issueShopifyOAuthState(
    { redis: testRedis, secret: TEST_SHOPIFY_OAUTH_STATE_SECRET },
    { userId: t.userId, organizationId: t.organizationId, shop },
  );
}

function shopFor(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`;
}

describe('GET /v1/orgs/:id/integrations/shopify/connect', () => {
  it('redirects to the Shopify authorize URL for a valid shop domain', async () => {
    const app = appWith();
    try {
      const t = await tenant('connect-ok');
      const shop = shopFor('connect-ok');
      const res = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${t.organizationId}/integrations/shopify/connect?shop=${shop}`,
        headers: { cookie: t.cookie, origin: ORIGIN },
      });
      expect(res.statusCode).toBe(302);
      const location = new URL(res.headers.location as string);
      expect(location.host).toBe(shop);
      expect(location.pathname).toBe('/admin/oauth/authorize');
      expect(location.searchParams.get('state')).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('rejects an invalid shop domain', async () => {
    const app = appWith();
    try {
      const t = await tenant('connect-bad-shop');
      const res = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${t.organizationId}/integrations/shopify/connect?shop=not-a-shop`,
        headers: { cookie: t.cookie, origin: ORIGIN },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_shop_domain' });
    } finally {
      await app.close();
    }
  });

  it('denies a member without integrations.manage (viewer)', async () => {
    const app = appWith();
    try {
      const owner = await tenant('connect-viewer-owner');
      const viewer = await addRealMember(testAuth, testDb, owner, 'connect-viewer', 'viewer');
      cleanups.push(() => cleanupRealMember(testDb, viewer));
      const res = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${owner.organizationId}/integrations/shopify/connect?shop=${shopFor('x')}`,
        headers: { cookie: viewer.cookie, origin: ORIGIN },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

describe('GET /v1/integrations/shopify/callback', () => {
  it('happy path: creates the store and integration, encrypts credentials, audits integration_connected, redirects', async () => {
    const app = appWith();
    try {
      const t = await tenant('callback-ok');
      const shop = shopFor('callback-ok');
      const state = await issueState(t, shop);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/integrations/shopify/callback?shop=${shop}&code=the-code&state=${encodeURIComponent(state)}`,
        headers: { cookie: t.cookie },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain(TEST_DASHBOARD_URL);

      const [store] = await testDb
        .select()
        .from(schema.stores)
        .where(eq(schema.stores.shopDomain, shop));
      expect(store?.status).toBe('active');
      expect(store?.organizationId).toBe(t.organizationId);

      const [integration] = await testDb
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.storeId, store!.id));
      expect(integration?.status).toBe('active');
      expect(integration?.externalAccountId).toBe(`gid://shopify/Shop/${shop}`);
      const decrypted = testCredentialsCipher.decrypt(
        { integrationId: integration!.id },
        integration!.encryptedCredentials!,
      );
      expect(JSON.parse(decrypted)).toEqual(DEFAULT_CREDENTIALS);

      const [auditRow] = await testDb
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetId, integration!.id));
      expect(auditRow?.action).toBe('integration_connected');
      expect(auditRow?.actorUserId).toBe(t.userId);

      await testDb.delete(schema.integrations).where(eq(schema.integrations.id, integration!.id));
      await testDb.delete(schema.stores).where(eq(schema.stores.id, store!.id));
    } finally {
      await app.close();
    }
  });

  it('re-auth updates the existing store and integration rather than duplicating them', async () => {
    const app = appWith();
    try {
      const t = await tenant('callback-reauth');
      const shop = shopFor('callback-reauth');

      const state1 = await issueState(t, shop);
      await app.inject({
        method: 'GET',
        url: `/v1/integrations/shopify/callback?shop=${shop}&code=code-1&state=${encodeURIComponent(state1)}`,
        headers: { cookie: t.cookie },
      });
      const state2 = await issueState(t, shop);
      await app.inject({
        method: 'GET',
        url: `/v1/integrations/shopify/callback?shop=${shop}&code=code-2&state=${encodeURIComponent(state2)}`,
        headers: { cookie: t.cookie },
      });

      const storeRows = await testDb
        .select()
        .from(schema.stores)
        .where(eq(schema.stores.shopDomain, shop));
      expect(storeRows).toHaveLength(1);
      const integrationRows = await testDb
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.storeId, storeRows[0]!.id));
      expect(integrationRows).toHaveLength(1);

      await testDb
        .delete(schema.integrations)
        .where(eq(schema.integrations.id, integrationRows[0]!.id));
      await testDb.delete(schema.stores).where(eq(schema.stores.id, storeRows[0]!.id));
    } finally {
      await app.close();
    }
  });

  it('rejects when no session is present', async () => {
    const app = appWith();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/integrations/shopify/callback?shop=${shopFor('x')}&code=c&state=s`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects a callback whose session user differs from the state token’s user', async () => {
    const app = appWith();
    try {
      const stateOwner = await tenant('callback-mismatch-state-owner');
      const otherUser = await tenant('callback-mismatch-other-user');
      const shop = shopFor('callback-mismatch-user');
      const state = await issueState(stateOwner, shop);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/integrations/shopify/callback?shop=${shop}&code=c&state=${encodeURIComponent(state)}`,
        headers: { cookie: otherUser.cookie }, // different signed-in user
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'invalid_oauth_state' });
      expect(
        await testDb.select().from(schema.stores).where(eq(schema.stores.shopDomain, shop)),
      ).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('rejects a callback whose shop query param differs from the state token’s shop', async () => {
    const app = appWith();
    try {
      const t = await tenant('callback-mismatch-shop');
      const state = await issueState(t, shopFor('signed-for'));
      const res = await app.inject({
        method: 'GET',
        url: `/v1/integrations/shopify/callback?shop=${shopFor('different')}&code=c&state=${encodeURIComponent(state)}`,
        headers: { cookie: t.cookie },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'invalid_oauth_state' });
    } finally {
      await app.close();
    }
  });

  it('rejects a reused (already-consumed) state token', async () => {
    const app = appWith();
    try {
      const t = await tenant('callback-reused-nonce');
      const shop = shopFor('callback-reused-nonce');
      const state = await issueState(t, shop);
      const url = `/v1/integrations/shopify/callback?shop=${shop}&code=c&state=${encodeURIComponent(state)}`;

      const first = await app.inject({ method: 'GET', url, headers: { cookie: t.cookie } });
      expect(first.statusCode).toBe(302);
      const second = await app.inject({ method: 'GET', url, headers: { cookie: t.cookie } });
      expect(second.statusCode).toBe(403);
      expect(second.json()).toEqual({ error: 'invalid_oauth_state' });

      const [store] = await testDb
        .select()
        .from(schema.stores)
        .where(eq(schema.stores.shopDomain, shop));
      await testDb.delete(schema.integrations).where(eq(schema.integrations.storeId, store!.id));
      await testDb.delete(schema.stores).where(eq(schema.stores.id, store!.id));
    } finally {
      await app.close();
    }
  });

  it('rejects an expired state token even with a valid signature', async () => {
    const app = appWith();
    try {
      const t = await tenant('callback-expired');
      const shop = shopFor('callback-expired');
      const { createHmac } = await import('node:crypto');
      const payload = {
        userId: t.userId,
        organizationId: t.organizationId,
        shop,
        nonce: 'x',
        exp: Date.now() - 1000,
      };
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const signature = createHmac('sha256', TEST_SHOPIFY_OAUTH_STATE_SECRET)
        .update(payloadB64)
        .digest('base64url');
      const state = `${payloadB64}.${signature}`;

      const res = await app.inject({
        method: 'GET',
        url: `/v1/integrations/shopify/callback?shop=${shop}&code=c&state=${encodeURIComponent(state)}`,
        headers: { cookie: t.cookie },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('rejects when the user has since lost integrations.manage (demoted before the callback completes)', async () => {
    const app = appWith();
    try {
      const owner = await tenant('callback-demoted-owner');
      const admin = await addRealMember(testAuth, testDb, owner, 'callback-demoted', 'admin');
      cleanups.push(() => cleanupRealMember(testDb, admin));
      const shop = shopFor('callback-demoted');
      const state = await issueShopifyOAuthState(
        { redis: testRedis, secret: TEST_SHOPIFY_OAUTH_STATE_SECRET },
        { userId: admin.userId, organizationId: owner.organizationId, shop },
      );

      // Demote after the state was issued, before the callback runs.
      const membership = await resolveMembership(testDb, admin.userId, owner.organizationId);
      await testAuth.api.updateMemberRole({
        body: { memberId: membership!.id, role: 'viewer', organizationId: owner.organizationId },
        headers: new Headers({ cookie: owner.cookie }),
      });

      const res = await app.inject({
        method: 'GET',
        url: `/v1/integrations/shopify/callback?shop=${shop}&code=c&state=${encodeURIComponent(state)}`,
        headers: { cookie: admin.cookie },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'invalid_oauth_state' });
    } finally {
      await app.close();
    }
  });

  it('rejects missing query parameters with 400, not 403', async () => {
    const app = appWith();
    try {
      const t = await tenant('callback-missing-params');
      const res = await app.inject({
        method: 'GET',
        url: '/v1/integrations/shopify/callback',
        headers: { cookie: t.cookie },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('ignores an extra/tampered orgId query parameter — the organization comes only from the verified state token', async () => {
    const app = appWith();
    try {
      const real = await tenant('callback-org-param-real');
      const attackerOrg = await tenant('callback-org-param-attacker');
      const shop = shopFor('callback-org-param');
      const state = await issueState(real, shop);

      // The route's Querystring type has no orgId/organizationId field at all — this proves an
      // attacker-supplied one in the raw URL is never read, not merely overridden.
      const res = await app.inject({
        method: 'GET',
        url: `/v1/integrations/shopify/callback?shop=${shop}&code=c&state=${encodeURIComponent(state)}&orgId=${attackerOrg.organizationId}&organizationId=${attackerOrg.organizationId}`,
        headers: { cookie: real.cookie },
      });
      expect(res.statusCode).toBe(302);

      const [store] = await testDb
        .select()
        .from(schema.stores)
        .where(eq(schema.stores.shopDomain, shop));
      expect(store?.organizationId).toBe(real.organizationId);
      expect(store?.organizationId).not.toBe(attackerOrg.organizationId);

      await testDb.delete(schema.integrations).where(eq(schema.integrations.storeId, store!.id));
      await testDb.delete(schema.stores).where(eq(schema.stores.id, store!.id));
    } finally {
      await app.close();
    }
  });

  it('returns 409 shop_linked_elsewhere when the shop already belongs to a different organization', async () => {
    const app = appWith();
    try {
      const tenantA = await tenant('callback-conflict-a');
      const tenantB = await tenant('callback-conflict-b');
      const shop = shopFor('callback-conflict');

      const stateA = await issueState(tenantA, shop);
      await app.inject({
        method: 'GET',
        url: `/v1/integrations/shopify/callback?shop=${shop}&code=c1&state=${encodeURIComponent(stateA)}`,
        headers: { cookie: tenantA.cookie },
      });

      const stateB = await issueState(tenantB, shop);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/integrations/shopify/callback?shop=${shop}&code=c2&state=${encodeURIComponent(stateB)}`,
        headers: { cookie: tenantB.cookie },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'shop_linked_elsewhere' });

      const [store] = await testDb
        .select()
        .from(schema.stores)
        .where(eq(schema.stores.shopDomain, shop));
      await testDb.delete(schema.integrations).where(eq(schema.integrations.storeId, store!.id));
      await testDb.delete(schema.stores).where(eq(schema.stores.id, store!.id));
    } finally {
      await app.close();
    }
  });

  it('returns 502 when the Shopify token exchange fails', async () => {
    const app = appWith({ exchangeCodeError: true });
    try {
      const t = await tenant('callback-exchange-fails');
      const shop = shopFor('callback-exchange-fails');
      const state = await issueState(t, shop);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/integrations/shopify/callback?shop=${shop}&code=c&state=${encodeURIComponent(state)}`,
        headers: { cookie: t.cookie },
      });
      expect(res.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });

  it('returns 502 when the Shopify shop-info query fails', async () => {
    const app = appWith({ shopInfoError: true });
    try {
      const t = await tenant('callback-shopinfo-fails');
      const shop = shopFor('callback-shopinfo-fails');
      const state = await issueState(t, shop);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/integrations/shopify/callback?shop=${shop}&code=c&state=${encodeURIComponent(state)}`,
        headers: { cookie: t.cookie },
      });
      expect(res.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });
});

describe('DELETE /v1/orgs/:id/integrations/:integrationId', () => {
  it('revokes the integration and wipes credentials, and audits integration_disconnected', async () => {
    const app = appWith();
    try {
      const t = await tenant('delete-ok');
      const shop = shopFor('delete-ok');
      const state = await issueState(t, shop);
      await app.inject({
        method: 'GET',
        url: `/v1/integrations/shopify/callback?shop=${shop}&code=c&state=${encodeURIComponent(state)}`,
        headers: { cookie: t.cookie },
      });
      const [store] = await testDb
        .select()
        .from(schema.stores)
        .where(eq(schema.stores.shopDomain, shop));
      const [integration] = await testDb
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.storeId, store!.id));

      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${t.organizationId}/integrations/${integration!.id}`,
        headers: { cookie: t.cookie, origin: ORIGIN },
      });
      expect(res.statusCode).toBe(204);

      const [revoked] = await testDb
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.id, integration!.id));
      expect(revoked?.status).toBe('revoked');
      expect(revoked?.encryptedCredentials).toBeNull();

      const disconnectRows = await testDb
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetId, integration!.id));
      expect(disconnectRows.some((r) => r.action === 'integration_disconnected')).toBe(true);

      await testDb.delete(schema.integrations).where(eq(schema.integrations.id, integration!.id));
      await testDb.delete(schema.stores).where(eq(schema.stores.id, store!.id));
    } finally {
      await app.close();
    }
  });

  it('returns 404 for a nonexistent integration id', async () => {
    const app = appWith();
    try {
      const t = await tenant('delete-not-found');
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${t.organizationId}/integrations/00000000-0000-0000-0000-000000000000`,
        headers: { cookie: t.cookie, origin: ORIGIN },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns 404 for another organization's integration id, even under the caller's own org path (ADR-0024)", async () => {
    const app = appWith();
    try {
      const tenantA = await tenant('delete-foreign-a');
      const tenantB = await tenant('delete-foreign-b');
      const shop = shopFor('delete-foreign');
      const state = await issueState(tenantB, shop);
      await app.inject({
        method: 'GET',
        url: `/v1/integrations/shopify/callback?shop=${shop}&code=c&state=${encodeURIComponent(state)}`,
        headers: { cookie: tenantB.cookie },
      });
      const [store] = await testDb
        .select()
        .from(schema.stores)
        .where(eq(schema.stores.shopDomain, shop));
      const [integrationB] = await testDb
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.storeId, store!.id));

      // tenantA's own org id in the path, but tenantB's integration id.
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${tenantA.organizationId}/integrations/${integrationB!.id}`,
        headers: { cookie: tenantA.cookie, origin: ORIGIN },
      });
      expect(res.statusCode).toBe(404);

      const [stillActive] = await testDb
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.id, integrationB!.id));
      expect(stillActive?.status).toBe('active');

      await testDb.delete(schema.integrations).where(eq(schema.integrations.id, integrationB!.id));
      await testDb.delete(schema.stores).where(eq(schema.stores.id, store!.id));
    } finally {
      await app.close();
    }
  });
});
