import type { Job } from 'bullmq';
import { cleanupTestTenant, db, seedTestTenant } from '@truepath/db/testing';
import { createIntegrationRepository } from '@truepath/db';
import type { ShopifyAdapter, ShopifyCredentials } from '@truepath/integrations';
import { createTestCredentialsCipher } from '@truepath/privacy/testing';
import type { ShopifySyncJob, TenantScope } from '@truepath/shared';
import { describe, expect, it, vi } from 'vitest';
import { createShopifySyncProcessor, type ShopifySyncDeps } from './shopifySync.js';

function ownerScope(organizationId: string, storeId: string, userId: string): TenantScope {
  return { kind: 'tenant', userId, organizationId, role: 'owner', storeIds: new Set([storeId]) };
}

function job(data: ShopifySyncJob): Job<ShopifySyncJob> {
  return { data } as Job<ShopifySyncJob>;
}

const CREDENTIALS: ShopifyCredentials = {
  accessToken: 'shpat_test',
  accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  refreshToken: 'shprt_test',
  refreshTokenExpiresAt: new Date(Date.now() + 7_776_000_000).toISOString(),
  scope: 'read_orders,write_pixels,read_customer_events',
};

function fakeAdapter(startBulkOrders = vi.fn().mockResolvedValue('gid://shopify/BulkOperation/1')) {
  const adapter: ShopifyAdapter = {
    provider: 'shopify',
    authUrl: () => '',
    exchangeCode: () => Promise.reject(new Error('not used')),
    refresh: () => Promise.reject(new Error('not used')),
    shopInfo: () => Promise.reject(new Error('not used')),
    healthCheck: () => Promise.resolve({ healthy: true }),
    verifyWebhook: () => true,
    fetchOrder: () => Promise.reject(new Error('not used')),
    startBulkOrders,
  };
  return { adapter, startBulkOrders };
}

describe('shopify-sync processor — mode: backfill (shopify-integration.md §4.7)', () => {
  it('decrypts the store credentials and starts a bulk query for the last N days', async () => {
    const tenant = await seedTestTenant('shopify-sync-backfill');
    try {
      const cipher = createTestCredentialsCipher();
      const scope = ownerScope(tenant.organizationId, tenant.storeId, tenant.userId);
      await createIntegrationRepository(db).upsertShopify(scope, {
        storeId: tenant.storeId,
        externalAccountId: 'gid://shopify/Shop/1',
        credentialsJson: JSON.stringify(CREDENTIALS),
        scopes: ['read_orders'],
        cipher,
      });

      const { adapter, startBulkOrders } = fakeAdapter();
      const deps: ShopifySyncDeps = { db, adapter, cipher };
      const before = Date.now();

      await createShopifySyncProcessor(deps)(
        job({ storeId: tenant.storeId, mode: 'backfill', days: 60 }),
      );

      expect(startBulkOrders).toHaveBeenCalledTimes(1);
      const [shop, creds, sinceIso] = startBulkOrders.mock.calls[0]!;
      expect(shop).toMatch(/\.myshopify\.com$/);
      expect(creds).toEqual(CREDENTIALS);
      const sinceMs = new Date(sinceIso as string).getTime();
      const expectedMs = before - 60 * 24 * 60 * 60 * 1000;
      expect(Math.abs(sinceMs - expectedMs)).toBeLessThan(5000);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('defaults to 60 days when the job carries no `days`', async () => {
    const tenant = await seedTestTenant('shopify-sync-backfill-default-days');
    try {
      const cipher = createTestCredentialsCipher();
      const scope = ownerScope(tenant.organizationId, tenant.storeId, tenant.userId);
      await createIntegrationRepository(db).upsertShopify(scope, {
        storeId: tenant.storeId,
        externalAccountId: 'gid://shopify/Shop/2',
        credentialsJson: JSON.stringify(CREDENTIALS),
        scopes: ['read_orders'],
        cipher,
      });

      const { adapter, startBulkOrders } = fakeAdapter();
      const deps: ShopifySyncDeps = { db, adapter, cipher };
      const before = Date.now();

      await createShopifySyncProcessor(deps)(job({ storeId: tenant.storeId, mode: 'backfill' }));

      const [, , sinceIso] = startBulkOrders.mock.calls[0]!;
      const sinceMs = new Date(sinceIso as string).getTime();
      expect(Math.abs(sinceMs - (before - 60 * 24 * 60 * 60 * 1000))).toBeLessThan(5000);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('is a no-op when the store no longer exists', async () => {
    const { adapter, startBulkOrders } = fakeAdapter();
    const deps: ShopifySyncDeps = { db, adapter, cipher: createTestCredentialsCipher() };

    await createShopifySyncProcessor(deps)(
      job({ storeId: '00000000-0000-0000-0000-000000000000', mode: 'backfill' }),
    );

    expect(startBulkOrders).not.toHaveBeenCalled();
  });

  it('throws when the store has no active Shopify integration', async () => {
    const tenant = await seedTestTenant('shopify-sync-backfill-no-integration');
    try {
      const { adapter } = fakeAdapter();
      const deps: ShopifySyncDeps = { db, adapter, cipher: createTestCredentialsCipher() };

      await expect(
        createShopifySyncProcessor(deps)(job({ storeId: tenant.storeId, mode: 'backfill' })),
      ).rejects.toThrow('no active Shopify integration');
    } finally {
      await cleanupTestTenant(tenant);
    }
  });
});

describe('shopify-sync processor — unimplemented modes', () => {
  it.each(['bulk_result', 'reconcile', 'order_refresh'] as const)(
    'throws a clear error for %s (not built yet)',
    async (mode) => {
      const { adapter } = fakeAdapter();
      const deps: ShopifySyncDeps = { db, adapter, cipher: createTestCredentialsCipher() };
      await expect(
        createShopifySyncProcessor(deps)(job({ storeId: 'irrelevant', mode })),
      ).rejects.toThrow(`'${mode}' is not implemented yet`);
    },
  );
});
