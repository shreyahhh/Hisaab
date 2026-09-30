import { createIntegrationRepository, jobScope } from '@truepath/db';
import { cleanupTestTenant, seedTestTenant, type TestTenant } from '@truepath/db/testing';
import {
  ShopifyUnauthorizedError,
  type ShopifyAdapter,
  type ShopifyCredentials,
} from '@truepath/integrations';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchOrderWithTokenRefresh } from './shopifyOrderCredentials.js';
import { testCredentialsCipher, testDb } from './testApp.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function tenantWithIntegration(
  label: string,
  creds: ShopifyCredentials,
): Promise<TestTenant> {
  const t = await seedTestTenant(label);
  cleanups.push(() => cleanupTestTenant(t));
  await createIntegrationRepository(testDb).upsertShopify(jobScope(t.organizationId, t.storeId), {
    storeId: t.storeId,
    externalAccountId: 'gid://shopify/Shop/1',
    credentialsJson: JSON.stringify(creds),
    scopes: ['read_orders'],
    cipher: testCredentialsCipher,
  });
  return t;
}

const VALID_CREDS: ShopifyCredentials = {
  accessToken: 'shpat_valid',
  accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  refreshToken: 'shprt_valid',
  refreshTokenExpiresAt: new Date(Date.now() + 7_776_000_000).toISOString(),
  scope: 'read_orders',
};

function fakeAdapter(options: {
  fetchOrderImpl?: (creds: ShopifyCredentials) => Promise<null>;
  refreshImpl?: () => Promise<ShopifyCredentials>;
}): ShopifyAdapter {
  return {
    provider: 'shopify',
    authUrl: () => '',
    exchangeCode: async () => VALID_CREDS,
    refresh: options.refreshImpl ?? (async (_shop, creds) => creds),
    shopInfo: async () => ({ gid: 'x', myshopifyDomain: 'x', currency: 'INR' }),
    healthCheck: async () => ({ healthy: true }),
    verifyWebhook: () => true,
    fetchOrder: async (_shop, creds) =>
      options.fetchOrderImpl ? options.fetchOrderImpl(creds) : null,
    startBulkOrders: async () => 'gid://shopify/BulkOperation/test',
    bulkOperation: async () => null,
    streamBulkOrders: async function* () {
      // no result rows
    },
    upsertWebPixel: async () => ({ pixelId: 'gid://shopify/WebPixel/test' }),
    uninstallApp: async () => ({ success: true, errorCount: 0 }),
  };
}

describe('fetchOrderWithTokenRefresh', () => {
  it('decrypts the stored credentials and calls fetchOrder with them', async () => {
    const t = await tenantWithIntegration('creds-happy-path', VALID_CREDS);
    let receivedToken: string | undefined;
    const adapter = fakeAdapter({
      fetchOrderImpl: async (creds) => {
        receivedToken = creds.accessToken;
        return null;
      },
    });
    await fetchOrderWithTokenRefresh(
      { db: testDb, adapter, cipher: testCredentialsCipher },
      jobScope(t.organizationId, t.storeId),
      t.storeId,
      'shop.myshopify.com',
      '1001',
    );
    expect(receivedToken).toBe('shpat_valid');
  });

  it('refreshes once on a 401 and retries with the new token', async () => {
    const t = await tenantWithIntegration('creds-401-refresh', VALID_CREDS);
    let attempt = 0;
    const refreshed: ShopifyCredentials = { ...VALID_CREDS, accessToken: 'shpat_refreshed' };
    const receivedTokens: string[] = [];
    const adapter = fakeAdapter({
      fetchOrderImpl: async (creds) => {
        attempt += 1;
        receivedTokens.push(creds.accessToken);
        if (attempt === 1) throw new ShopifyUnauthorizedError();
        return null;
      },
      refreshImpl: async () => refreshed,
    });
    await fetchOrderWithTokenRefresh(
      { db: testDb, adapter, cipher: testCredentialsCipher },
      jobScope(t.organizationId, t.storeId),
      t.storeId,
      'shop.myshopify.com',
      '1001',
    );
    expect(attempt).toBe(2);
    expect(receivedTokens).toEqual(['shpat_valid', 'shpat_refreshed']);

    // The refreshed token is persisted for next time.
    const stored = await createIntegrationRepository(testDb).getActiveByStore(
      jobScope(t.organizationId, t.storeId),
      t.storeId,
      'shopify',
    );
    const decrypted = JSON.parse(
      testCredentialsCipher.decrypt({ integrationId: stored!.id }, stored!.encryptedCredentials!),
    );
    expect(decrypted.accessToken).toBe('shpat_refreshed');
  });

  it('propagates a non-401 error without attempting a refresh', async () => {
    const t = await tenantWithIntegration('creds-other-error', VALID_CREDS);
    let refreshCalled = false;
    const adapter = fakeAdapter({
      fetchOrderImpl: async () => {
        throw new Error('some other failure');
      },
      refreshImpl: async () => {
        refreshCalled = true;
        return VALID_CREDS;
      },
    });
    await expect(
      fetchOrderWithTokenRefresh(
        { db: testDb, adapter, cipher: testCredentialsCipher },
        jobScope(t.organizationId, t.storeId),
        t.storeId,
        'shop.myshopify.com',
        '1001',
      ),
    ).rejects.toThrow('some other failure');
    expect(refreshCalled).toBe(false);
  });

  it('throws a clear error when the store has no active Shopify integration', async () => {
    const t = await seedTestTenant('creds-no-integration');
    cleanups.push(() => cleanupTestTenant(t));
    const adapter = fakeAdapter({});
    await expect(
      fetchOrderWithTokenRefresh(
        { db: testDb, adapter, cipher: testCredentialsCipher },
        jobScope(t.organizationId, t.storeId),
        t.storeId,
        'shop.myshopify.com',
        '1001',
      ),
    ).rejects.toThrow('no active Shopify integration');
  });
});
