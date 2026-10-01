import { eq } from 'drizzle-orm';
import { createDpaAcceptanceRepository, schema } from '@truepath/db';
import {
  ShopifyPixelError,
  type ShopifyAdapter,
  type ShopifyCredentials,
  type WebPixelSettings,
} from '@truepath/integrations';
import { CollectorStoreConfig, collectorStoreKey, type TenantScope } from '@truepath/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeKeyRotation, publishCollectorConfig, rotateSigningKey } from '../shopifyPixel.js';
import { issueShopifyOAuthState } from '../shopifyOAuthState.js';
import {
  buildTestApp,
  testCredentialsCipher,
  testDb,
  testHasher,
  testRedis,
  testDsrQueue,
  testIdentityStitchQueue,
  testShopifySyncQueue,
  TEST_DASHBOARD_URL,
  TEST_DPA_VERSION,
  TEST_SHOPIFY_OAUTH_STATE_SECRET,
  testAuth,
} from '../testApp.js';
import { cleanupRealTenant, seedRealTenant, type RealTenant } from '../testAuthTenant.js';

// The pixel install and collector-config publish that run inside the Shopify OAuth callback (M1-4,
// shopify-integration.md §4.1 steps 5-7, collector.md §2.5). Real Postgres and Redis; only the
// Shopify HTTP calls are faked (the adapter's own HTTP behaviour is tested in packages/integrations).

const COLLECTOR_URL = 'https://collect.truepath.example';
const CREDENTIALS: ShopifyCredentials = {
  accessToken: 'shpat_test',
  accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  refreshToken: 'shprt_test',
  refreshTokenExpiresAt: new Date(Date.now() + 7_776_000_000).toISOString(),
  scope: 'read_orders,write_pixels,read_customer_events',
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function tenant(label: string): Promise<RealTenant> {
  const t = await seedRealTenant(testAuth, testDb, label);
  cleanups.push(() => cleanupRealTenant(testDb, t));
  return t;
}

function fakeAdapter(upsertWebPixel: ShopifyAdapter['upsertWebPixel']): ShopifyAdapter {
  return {
    provider: 'shopify',
    authUrl: () => '',
    exchangeCode: async () => ({ ...CREDENTIALS, accessToken: `shpat_${Math.random()}` }),
    refresh: async (_shop, creds) => creds,
    shopInfo: async (shop) => ({
      gid: `gid://shopify/Shop/${shop}`,
      myshopifyDomain: shop,
      currency: 'INR',
    }),
    healthCheck: async () => ({ healthy: true }),
    verifyWebhook: () => true,
    fetchOrder: async () => null,
    startBulkOrders: async () => 'gid://shopify/BulkOperation/test',
    bulkOperation: async () => null,
    async *streamBulkOrders() {
      // none
    },
    upsertWebPixel,
    uninstallApp: async () => ({ success: true, errorCount: 0 }),
  };
}

function appWith(
  upsertWebPixel: ShopifyAdapter['upsertWebPixel'],
  collectorUrl: string | null = COLLECTOR_URL,
) {
  return buildTestApp({
    shopify: {
      adapter: fakeAdapter(upsertWebPixel),
      cipher: testCredentialsCipher,
      hasher: testHasher,
      redis: testRedis,
      oauthStateSecret: TEST_SHOPIFY_OAUTH_STATE_SECRET,
      appUrl: 'http://localhost:3000',
      dashboardUrl: TEST_DASHBOARD_URL,
      shopifySyncQueue: testShopifySyncQueue,
      identityStitchQueue: testIdentityStitchQueue,
      dsrQueue: testDsrQueue,
      ...(collectorUrl ? { collectorUrl } : {}),
    },
  });
}

const shopFor = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`;

async function connect(app: ReturnType<typeof appWith>, t: RealTenant, shop: string) {
  const state = await issueShopifyOAuthState(
    { redis: testRedis, secret: TEST_SHOPIFY_OAUTH_STATE_SECRET },
    { userId: t.userId, organizationId: t.organizationId, shop },
  );
  const res = await app.inject({
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
  const credentials = JSON.parse(
    testCredentialsCipher.decrypt(
      { integrationId: integration!.id },
      integration!.encryptedCredentials!,
    ),
  ) as ShopifyCredentials;
  const settings = integration!.settings as Record<string, string>;
  // Leave nothing behind in the shared local Redis or queue.
  cleanups.push(async () => {
    if (settings.store_key) await testRedis.del(collectorStoreKey(settings.store_key));
    await (
      await testShopifySyncQueue.getJob(`backfill-${store!.id}`)
    )
      ?.remove()
      .catch(() => undefined);
    await testDb.delete(schema.integrations).where(eq(schema.integrations.storeId, store!.id));
    await testDb.delete(schema.stores).where(eq(schema.stores.id, store!.id));
  });
  return { res, store: store!, integration: integration!, credentials, settings };
}

async function readConfig(storeKey: string) {
  const raw = await testRedis.get(collectorStoreKey(storeKey));
  return raw ? CollectorStoreConfig.parse(JSON.parse(raw)) : null;
}

describe('OAuth callback — pixel install (M1-4)', () => {
  it('creates the pixel with the store key, collector URL and signing key, and keeps the secret out of settings', async () => {
    const calls: WebPixelSettings[] = [];
    const app = appWith(async (_shop, _creds, settings) => {
      calls.push(settings);
      return { pixelId: 'gid://shopify/WebPixel/1' };
    });
    try {
      const t = await tenant('pixel-ok');
      const { res, credentials, settings } = await connect(app, t, shopFor('pixel-ok'));
      expect(res.statusCode).toBe(302);

      const key = credentials.pixelSigningKeys![0]!;
      expect(key.kid).toBe('s1');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        storeKey: settings.store_key,
        collectorUrl: COLLECTOR_URL,
        signingKid: 's1',
        signingSecret: key.secret,
        noticeVersion: 'v1',
      });
      expect(settings).toMatchObject({
        pixel_status: 'installed',
        pixel_id: 'gid://shopify/WebPixel/1',
      });
      // SPEC v0.3 secrets rule: the secret is only in the encrypted credentials.
      expect(JSON.stringify(settings)).not.toContain(key.secret);
    } finally {
      await app.close();
    }
  });

  it('publishes the Collector config — inactive with dpa_missing until the DPA is accepted', async () => {
    const app = appWith(async () => ({ pixelId: 'gid://shopify/WebPixel/1' }));
    try {
      const t = await tenant('pixel-config-inactive');
      const shop = shopFor('pixel-config-inactive');
      const { credentials, settings, store } = await connect(app, t, shop);
      const config = await readConfig(settings.store_key!);
      expect(config).toMatchObject({
        storeId: store.id,
        status: 'inactive',
        inactiveReason: 'dpa_missing',
        allowedOrigins: [`https://${shop}`],
        childDirected: false,
        noticeVersion: 'v1',
      });
      expect(config?.signingKeys).toEqual(credentials.pixelSigningKeys);
    } finally {
      await app.close();
    }
  });

  it('a reconnect keeps the same store key and signing secret, while replacing the OAuth tokens', async () => {
    const app = appWith(async () => ({ pixelId: 'gid://shopify/WebPixel/1' }));
    try {
      const t = await tenant('pixel-reconnect');
      const shop = shopFor('pixel-reconnect');
      const first = await connect(app, t, shop);
      const second = await connect(app, t, shop);
      expect(second.settings.store_key).toBe(first.settings.store_key);
      expect(second.credentials.pixelSigningKeys).toEqual(first.credentials.pixelSigningKeys);
      expect(second.credentials.accessToken).not.toBe(first.credentials.accessToken);
    } finally {
      await app.close();
    }
  });

  it('a pixel failure does not fail the connect: it records only the error codes, and still publishes the config', async () => {
    const app = appWith(async () => {
      throw new ShopifyPixelError(['NO_EXTENSION']);
    });
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '));
    try {
      const t = await tenant('pixel-fail');
      const { res, credentials, settings } = await connect(app, t, shopFor('pixel-fail'));
      expect(res.statusCode).toBe(302);
      expect(settings).toMatchObject({ pixel_status: 'failed', pixel_error_codes: 'NO_EXTENSION' });
      expect(await readConfig(settings.store_key!)).not.toBeNull();
      const output = logged.join('\n');
      expect(output).toContain('shopify_pixel_install_failed');
      expect(output).not.toContain(credentials.pixelSigningKeys![0]!.secret);
    } finally {
      console.error = original;
      await app.close();
    }
  });

  it('a non-Shopify failure is recorded as request_failed, without its message', async () => {
    const app = appWith(async () => {
      throw new Error('socket hang up while sending secret=abc');
    });
    const original = console.error;
    console.error = () => undefined;
    try {
      const t = await tenant('pixel-fail-generic');
      const { res, settings } = await connect(app, t, shopFor('pixel-fail-generic'));
      expect(res.statusCode).toBe(302);
      expect(settings).toMatchObject({
        pixel_status: 'failed',
        pixel_error_codes: 'request_failed',
      });
      expect(JSON.stringify(settings)).not.toContain('secret=abc');
    } finally {
      console.error = original;
      await app.close();
    }
  });

  it('without a configured Collector URL the pixel is not installed, but the config is still published', async () => {
    const upsert = vi.fn(async () => ({ pixelId: 'x' }));
    const app = appWith(upsert, null);
    try {
      const t = await tenant('pixel-no-collector');
      const { res, settings } = await connect(app, t, shopFor('pixel-no-collector'));
      expect(res.statusCode).toBe(302);
      expect(upsert).not.toHaveBeenCalled();
      expect(settings).toMatchObject({ pixel_status: 'not_configured' });
      expect(await readConfig(settings.store_key!)).not.toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe('publishCollectorConfig — the gates on `active` (privacy-dpdp §4.10, SPEC v0.6 P-1)', () => {
  async function connected(label: string) {
    const app = appWith(async () => ({ pixelId: 'gid://shopify/WebPixel/1' }));
    const t = await tenant(label);
    const result = await connect(app, t, shopFor(label));
    await app.close();
    const scope: TenantScope = {
      kind: 'tenant',
      userId: t.userId,
      organizationId: t.organizationId,
      role: 'owner',
      storeIds: new Set([result.store.id]),
    };
    const deps = {
      db: testDb,
      cipher: testCredentialsCipher,
      redis: testRedis,
      dpaVersion: TEST_DPA_VERSION,
    };
    const acceptDpa = () =>
      createDpaAcceptanceRepository(testDb).record(scope, {
        organizationId: t.organizationId,
        dpaVersion: TEST_DPA_VERSION,
        acceptedByUserId: t.userId,
        ipTruncated: null,
      });
    const confirmIndiaOptIn = () =>
      testDb
        .update(schema.stores)
        .set({
          privacyConfig: { checklist: { india_opt_in_confirmed_at: '2026-09-28T10:00:00Z' } },
        })
        .where(eq(schema.stores.id, result.store.id));
    return { ...result, scope, deps, acceptDpa, confirmIndiaOptIn };
  }

  it('DPA accepted but India opt-in not confirmed → inactive: consent_region_unconfirmed', async () => {
    const c = await connected('gate-dpa-only');
    await c.acceptDpa();
    const config = await publishCollectorConfig(c.deps, c.scope, c.store.id);
    expect(config).toMatchObject({
      status: 'inactive',
      inactiveReason: 'consent_region_unconfirmed',
    });
  });

  it('India opt-in confirmed but no DPA → inactive: dpa_missing (the DPA gate comes first)', async () => {
    const c = await connected('gate-optin-only');
    await c.confirmIndiaOptIn();
    const config = await publishCollectorConfig(c.deps, c.scope, c.store.id);
    expect(config).toMatchObject({ status: 'inactive', inactiveReason: 'dpa_missing' });
  });

  it('both gates satisfied → active, and the key in Redis reflects it', async () => {
    const c = await connected('gate-both');
    await c.acceptDpa();
    await c.confirmIndiaOptIn();
    const config = await publishCollectorConfig(c.deps, c.scope, c.store.id);
    expect(config).toMatchObject({ status: 'active', inactiveReason: null });
    expect(await readConfig(c.settings.store_key!)).toMatchObject({ status: 'active' });
  });

  it('a DPA accepted at an older version does not open the gate', async () => {
    const c = await connected('gate-old-dpa');
    await createDpaAcceptanceRepository(testDb).record(c.scope, {
      organizationId: c.store.organizationId,
      dpaVersion: 'old-0',
      acceptedByUserId: c.scope.userId!,
      ipTruncated: null,
    });
    await c.confirmIndiaOptIn();
    expect(await publishCollectorConfig(c.deps, c.scope, c.store.id)).toMatchObject({
      status: 'inactive',
      inactiveReason: 'dpa_missing',
    });
  });

  it('an uninstalled store is inactive: uninstalled — and child_directed and the notice version are carried', async () => {
    const c = await connected('gate-uninstalled');
    await c.acceptDpa();
    await testDb
      .update(schema.stores)
      .set({
        childDirected: true,
        status: 'uninstalled',
        privacyConfig: {
          notice_version: 'v7',
          checklist: { india_opt_in_confirmed_at: '2026-09-28T10:00:00Z' },
        },
      })
      .where(eq(schema.stores.id, c.store.id));
    expect(await publishCollectorConfig(c.deps, c.scope, c.store.id)).toMatchObject({
      status: 'inactive',
      inactiveReason: 'uninstalled',
      childDirected: true,
      noticeVersion: 'v7',
    });
  });

  it('publishes nothing for a store that has no keys yet', async () => {
    const t = await tenant('gate-no-keys');
    const [store] = await testDb
      .insert(schema.stores)
      .values({
        organizationId: t.organizationId,
        platform: 'shopify',
        shopDomain: shopFor('gate-no-keys'),
      })
      .returning();
    cleanups.push(
      async () => void (await testDb.delete(schema.stores).where(eq(schema.stores.id, store!.id))),
    );
    const scope: TenantScope = {
      kind: 'tenant',
      userId: t.userId,
      organizationId: t.organizationId,
      role: 'owner',
      storeIds: new Set([store!.id]),
    };
    const deps = {
      db: testDb,
      cipher: testCredentialsCipher,
      redis: testRedis,
      dpaVersion: TEST_DPA_VERSION,
    };
    expect(await publishCollectorConfig(deps, scope, store!.id)).toBeNull();
  });
});

describe('POST /v1/orgs/:id/dpa/accept republishes the collector config (issue #22)', () => {
  it('a store stuck on dpa_missing (India opt-in already confirmed) goes active right after accept', async () => {
    const app = appWith(async () => ({ pixelId: 'gid://shopify/WebPixel/1' }));
    const t = await tenant('dpa-republish');
    const result = await connect(app, t, shopFor('dpa-republish'));
    await testDb
      .update(schema.stores)
      .set({
        privacyConfig: { checklist: { india_opt_in_confirmed_at: '2026-09-28T10:00:00Z' } },
      })
      .where(eq(schema.stores.id, result.store.id));

    // Before accept: DPA missing, so still inactive — confirms the fixture is a faithful repro of
    // "only the DPA gate is missing" rather than accidentally already active.
    expect(await readConfig(result.settings.store_key!)).toMatchObject({
      status: 'inactive',
      inactiveReason: 'dpa_missing',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${t.organizationId}/dpa/accept`,
      headers: { cookie: t.cookie, origin: TEST_DASHBOARD_URL },
      payload: { dpa_version: TEST_DPA_VERSION },
    });
    expect(res.statusCode).toBe(201);

    expect(await readConfig(result.settings.store_key!)).toMatchObject({
      status: 'active',
      inactiveReason: null,
    });
    await app.close();
  });

  it('a store with no active Shopify integration is a harmless no-op (nothing to publish yet)', async () => {
    const t = await tenant('dpa-republish-no-store');
    const app = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${t.organizationId}/dpa/accept`,
      headers: { cookie: t.cookie, origin: TEST_DASHBOARD_URL },
      payload: { dpa_version: TEST_DPA_VERSION },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });
});

describe('POST /v1/stores/:id/privacy/confirm-india-opt-in republishes the collector config (issue #72)', () => {
  it('a store stuck on consent_region_unconfirmed (DPA already accepted) goes active right after confirming', async () => {
    const app = appWith(async () => ({ pixelId: 'gid://shopify/WebPixel/1' }));
    const t = await tenant('optin-republish');
    const result = await connect(app, t, shopFor('optin-republish'));
    const scope: TenantScope = {
      kind: 'tenant',
      userId: t.userId,
      organizationId: t.organizationId,
      role: 'owner',
      storeIds: new Set([result.store.id]),
    };
    await createDpaAcceptanceRepository(testDb).record(scope, {
      organizationId: t.organizationId,
      dpaVersion: TEST_DPA_VERSION,
      acceptedByUserId: t.userId,
      ipTruncated: null,
    });
    // Direct-inserting the DPA row (unlike POST /dpa/accept) does not republish on its own — publish
    // once here to reach the "only the consent-region gate is missing" starting state.
    await publishCollectorConfig(
      { db: testDb, cipher: testCredentialsCipher, redis: testRedis, dpaVersion: TEST_DPA_VERSION },
      scope,
      result.store.id,
    );
    expect(await readConfig(result.settings.store_key!)).toMatchObject({
      status: 'inactive',
      inactiveReason: 'consent_region_unconfirmed',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/stores/${result.store.id}/privacy/confirm-india-opt-in`,
      headers: { cookie: t.cookie, origin: TEST_DASHBOARD_URL },
      payload: {},
    });
    expect(res.statusCode).toBe(201);

    expect(await readConfig(result.settings.store_key!)).toMatchObject({
      status: 'active',
      inactiveReason: null,
    });
    await app.close();
  });

  it('confirming still succeeds for a store with no active Shopify integration (nothing to publish yet)', async () => {
    const t = await tenant('optin-republish-no-store');
    const app = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/stores/${t.storeId}/privacy/confirm-india-opt-in`,
      headers: { cookie: t.cookie, origin: TEST_DASHBOARD_URL },
      payload: {},
    });
    // seedRealTenant's store has no Shopify integration, but it is a real store the caller owns, so
    // confirmation still succeeds — publishCollectorConfig is just a harmless no-op (no keys yet).
    expect(res.statusCode).toBe(201);
    await app.close();
  });
});

describe('rotateSigningKey / completeKeyRotation (S-6, issue #45)', () => {
  async function connectedForRotation(label: string) {
    const upsertWebPixel = vi.fn<ShopifyAdapter['upsertWebPixel']>(async () => ({
      pixelId: 'gid://shopify/WebPixel/1',
    }));
    const adapter = fakeAdapter(upsertWebPixel);
    const app = buildTestApp({
      shopify: {
        adapter,
        cipher: testCredentialsCipher,
        hasher: testHasher,
        redis: testRedis,
        oauthStateSecret: TEST_SHOPIFY_OAUTH_STATE_SECRET,
        appUrl: 'http://localhost:3000',
        dashboardUrl: TEST_DASHBOARD_URL,
        shopifySyncQueue: testShopifySyncQueue,
        identityStitchQueue: testIdentityStitchQueue,
        dsrQueue: testDsrQueue,
        collectorUrl: COLLECTOR_URL,
      },
    });
    const t = await tenant(label);
    const result = await connect(app, t, shopFor(label));
    await app.close(); // the HTTP layer isn't needed after connect — the functions under test are called directly
    upsertWebPixel.mockClear(); // connect() itself calls it once; tests below assert only their own calls
    const scope: TenantScope = {
      kind: 'tenant',
      userId: t.userId,
      organizationId: t.organizationId,
      role: 'owner',
      storeIds: new Set([result.store.id]),
    };
    const pixelDeps = {
      db: testDb,
      adapter,
      cipher: testCredentialsCipher,
      redis: testRedis,
      collectorUrl: COLLECTOR_URL,
      dpaVersion: TEST_DPA_VERSION,
    };
    return { ...result, scope, pixelDeps, upsertWebPixel };
  }

  function decryptedKeys(integrationId: string, encrypted: Buffer): readonly { kid: string }[] {
    const creds = JSON.parse(
      testCredentialsCipher.decrypt({ integrationId }, encrypted),
    ) as ShopifyCredentials;
    return creds.pixelSigningKeys ?? [];
  }

  it('adds a second key, pushes it to the live pixel, and the config accepts both during rollout', async () => {
    const c = await connectedForRotation('rotate-add');
    const before = decryptedKeys(c.integration.id, c.integration.encryptedCredentials!);
    expect(before).toHaveLength(1);
    const originalKid = before[0]!.kid;

    const result = await rotateSigningKey(c.pixelDeps, c.scope, c.store.id);
    expect(result?.newKid).toBe('s2');

    const [updated] = await testDb
      .select()
      .from(schema.integrations)
      .where(eq(schema.integrations.id, c.integration.id));
    const afterKeys = decryptedKeys(c.integration.id, updated!.encryptedCredentials!);
    expect(afterKeys.map((k) => k.kid)).toEqual([originalKid, 's2']);

    expect(c.upsertWebPixel).toHaveBeenCalledTimes(1);
    const settingsArg = c.upsertWebPixel.mock.calls[0]![2] as WebPixelSettings;
    expect(settingsArg.signingKid).toBe('s2');

    const config = await readConfig(c.settings.store_key!);
    expect(config?.signingKeys.map((k) => k.kid)).toEqual([originalKid, 's2']);
  });

  it('without a configured Collector URL, the key is still stored and republished, but Shopify is never called', async () => {
    const c = await connectedForRotation('rotate-no-collector');
    const noCollectorDeps = { ...c.pixelDeps, collectorUrl: undefined };

    const result = await rotateSigningKey(noCollectorDeps, c.scope, c.store.id);
    expect(result?.newKid).toBe('s2');
    expect(c.upsertWebPixel).not.toHaveBeenCalled();

    const config = await readConfig(c.settings.store_key!);
    expect(config?.signingKeys.map((k) => k.kid)).toEqual(['s1', 's2']);
  });

  it('returns null for a store with no active Shopify integration', async () => {
    const t = await tenant('rotate-no-integration');
    const scope: TenantScope = {
      kind: 'tenant',
      userId: t.userId,
      organizationId: t.organizationId,
      role: 'owner',
      storeIds: new Set([t.storeId]),
    };
    const upsertWebPixel = vi.fn(async () => ({ pixelId: 'x' }));
    const pixelDeps = {
      db: testDb,
      adapter: fakeAdapter(upsertWebPixel),
      cipher: testCredentialsCipher,
      redis: testRedis,
      collectorUrl: COLLECTOR_URL,
      dpaVersion: TEST_DPA_VERSION,
    };
    expect(await rotateSigningKey(pixelDeps, scope, t.storeId)).toBeNull();
    expect(upsertWebPixel).not.toHaveBeenCalled();
  });

  it('completeKeyRotation drops every key but the newest, and the config narrows immediately', async () => {
    const c = await connectedForRotation('rotate-complete');
    await rotateSigningKey(c.pixelDeps, c.scope, c.store.id);

    await completeKeyRotation(c.pixelDeps, c.scope, c.store.id);

    const [updated] = await testDb
      .select()
      .from(schema.integrations)
      .where(eq(schema.integrations.id, c.integration.id));
    const afterKeys = decryptedKeys(c.integration.id, updated!.encryptedCredentials!);
    expect(afterKeys.map((k) => k.kid)).toEqual(['s2']);

    const config = await readConfig(c.settings.store_key!);
    expect(config?.signingKeys.map((k) => k.kid)).toEqual(['s2']);
  });

  it('completeKeyRotation is a no-op when there is only one key (rotation never started)', async () => {
    const c = await connectedForRotation('rotate-complete-noop');
    await completeKeyRotation(c.pixelDeps, c.scope, c.store.id);

    const [updated] = await testDb
      .select()
      .from(schema.integrations)
      .where(eq(schema.integrations.id, c.integration.id));
    expect(decryptedKeys(c.integration.id, updated!.encryptedCredentials!)).toHaveLength(1);
  });
});
