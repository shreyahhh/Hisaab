import type { TenantScope } from '@truepath/shared';
import { createTestCredentialsCipher } from '@truepath/privacy/testing';
import { describe, expect, it } from 'vitest';
import { createIntegrationRepository } from './integrationRepository.js';
import { cleanupTestTenant, db, seedTestTenant } from '../testing.js';

function ownerScope(organizationId: string, storeId: string, userId: string): TenantScope {
  return { kind: 'tenant', userId, organizationId, role: 'owner', storeIds: new Set([storeId]) };
}

function jobScope(organizationId: string, storeId: string): TenantScope {
  return {
    kind: 'tenant',
    userId: null,
    organizationId,
    role: 'job',
    storeIds: new Set([storeId]),
  };
}

describe('IntegrationRepository (ADR-0016, ADR-0023, ADR-0024)', () => {
  it('creates a Shopify integration, encrypted so it decrypts under its own row id, and finds it within its own org scope', async () => {
    const tenant = await seedTestTenant('integration-repo');
    try {
      const repo = createIntegrationRepository(db);
      const scope = ownerScope(tenant.organizationId, tenant.storeId, tenant.userId);
      const cipher = createTestCredentialsCipher();

      const created = await repo.upsertShopify(scope, {
        storeId: tenant.storeId,
        externalAccountId: 'gid://shopify/Shop/1',
        credentialsJson: JSON.stringify({ accessToken: 'shpat_x' }),
        scopes: ['read_orders'],
        cipher,
      });
      expect(created.status).toBe('active');
      expect(created.externalAccountId).toBe('gid://shopify/Shop/1');
      expect(created.encryptedCredentials).not.toBeNull();

      // ADR-0023: the envelope must decrypt under the row's own id (bound as AAD) ...
      const decrypted = cipher.decrypt(
        { integrationId: created.id },
        created.encryptedCredentials!,
      );
      expect(decrypted).toBe(JSON.stringify({ accessToken: 'shpat_x' }));
      // ... and fail under any other id, e.g. one belonging to a different row.
      expect(() =>
        cipher.decrypt(
          { integrationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
          created.encryptedCredentials!,
        ),
      ).toThrow();

      const found = await repo.getByIdForOrganization(scope, tenant.organizationId, created.id);
      expect(found?.id).toBe(created.id);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('re-auth (same store, same external account) updates the existing row rather than duplicating it, and the new envelope still decrypts under the unchanged id', async () => {
    const tenant = await seedTestTenant('integration-repo-reauth');
    try {
      const repo = createIntegrationRepository(db);
      const scope = ownerScope(tenant.organizationId, tenant.storeId, tenant.userId);
      const cipher = createTestCredentialsCipher();
      const input = {
        storeId: tenant.storeId,
        externalAccountId: 'gid://shopify/Shop/2',
        scopes: ['read_orders'],
        cipher,
      };
      const first = await repo.upsertShopify(scope, {
        ...input,
        credentialsJson: JSON.stringify({ accessToken: 'first' }),
      });
      const second = await repo.upsertShopify(scope, {
        ...input,
        credentialsJson: JSON.stringify({ accessToken: 'second' }),
        scopes: ['read_orders', 'write_pixels'],
      });

      expect(second.id).toBe(first.id);
      expect(second.scopes).toEqual(['read_orders', 'write_pixels']);
      expect(cipher.decrypt({ integrationId: second.id }, second.encryptedCredentials!)).toBe(
        JSON.stringify({ accessToken: 'second' }),
      );
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('getByIdForOrganization returns null for an integration belonging to a different org (not a throw)', async () => {
    const tenantA = await seedTestTenant('integration-repo-a');
    const tenantB = await seedTestTenant('integration-repo-b');
    try {
      const repo = createIntegrationRepository(db);
      const scopeB = ownerScope(tenantB.organizationId, tenantB.storeId, tenantB.userId);
      const integrationB = await repo.upsertShopify(scopeB, {
        storeId: tenantB.storeId,
        externalAccountId: 'gid://shopify/Shop/3',
        credentialsJson: '{}',
        scopes: [],
        cipher: createTestCredentialsCipher(),
      });

      const scopeA = ownerScope(tenantA.organizationId, tenantA.storeId, tenantA.userId);
      const found = await repo.getByIdForOrganization(
        scopeA,
        tenantA.organizationId,
        integrationB.id,
      );
      expect(found).toBeNull();
    } finally {
      await cleanupTestTenant(tenantA);
      await cleanupTestTenant(tenantB);
    }
  });

  it('revokeForOrganization wipes credentials and marks revoked, and returns null for a foreign integration', async () => {
    const tenantA = await seedTestTenant('integration-repo-revoke-a');
    const tenantB = await seedTestTenant('integration-repo-revoke-b');
    try {
      const repo = createIntegrationRepository(db);
      const scopeA = ownerScope(tenantA.organizationId, tenantA.storeId, tenantA.userId);
      const integrationA = await repo.upsertShopify(scopeA, {
        storeId: tenantA.storeId,
        externalAccountId: 'gid://shopify/Shop/4',
        credentialsJson: '{}',
        scopes: [],
        cipher: createTestCredentialsCipher(),
      });

      const scopeB = ownerScope(tenantB.organizationId, tenantB.storeId, tenantB.userId);
      const deniedResult = await repo.revokeForOrganization(
        scopeB,
        tenantB.organizationId,
        integrationA.id,
      );
      expect(deniedResult).toBeNull();

      const revoked = await repo.revokeForOrganization(
        scopeA,
        tenantA.organizationId,
        integrationA.id,
      );
      expect(revoked?.status).toBe('revoked');
      expect(revoked?.encryptedCredentials).toBeNull();
    } finally {
      await cleanupTestTenant(tenantA);
      await cleanupTestTenant(tenantB);
    }
  });

  it('markUninstalled revokes the store’s Shopify integration under a job scope (no signed-in user)', async () => {
    const tenant = await seedTestTenant('integration-repo-uninstall');
    try {
      const repo = createIntegrationRepository(db);
      const ownerCall = ownerScope(tenant.organizationId, tenant.storeId, tenant.userId);
      await repo.upsertShopify(ownerCall, {
        storeId: tenant.storeId,
        externalAccountId: 'gid://shopify/Shop/5',
        credentialsJson: '{}',
        scopes: [],
        cipher: createTestCredentialsCipher(),
      });

      const job = jobScope(tenant.organizationId, tenant.storeId);
      const uninstalled = await repo.markUninstalled(job, tenant.storeId);
      expect(uninstalled?.status).toBe('revoked');
      expect(uninstalled?.encryptedCredentials).toBeNull();
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('markUninstalled is a no-op (returns null) when there is no Shopify integration yet', async () => {
    const tenant = await seedTestTenant('integration-repo-uninstall-none');
    try {
      const repo = createIntegrationRepository(db);
      const job = jobScope(tenant.organizationId, tenant.storeId);
      expect(await repo.markUninstalled(job, tenant.storeId)).toBeNull();
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('patchShopifyBackfillState merges patches without dropping earlier keys, and stamps last_synced_at only on done', async () => {
    const tenant = await seedTestTenant('integration-repo-backfill-state');
    try {
      const repo = createIntegrationRepository(db);
      const job = jobScope(tenant.organizationId, tenant.storeId);
      const created = await repo.upsertShopify(job, {
        storeId: tenant.storeId,
        externalAccountId: 'gid://shopify/Shop/9',
        credentialsJson: JSON.stringify({ accessToken: 'shpat_x' }),
        scopes: ['read_orders'],
        cipher: createTestCredentialsCipher(),
      });
      // upsertShopify itself stamps last_synced_at on connect — capture it so "only on done" is a
      // real comparison rather than an accident of a null column.
      const afterConnect = created.lastSyncedAt;

      const running = await repo.patchShopifyBackfillState(job, tenant.storeId, {
        days: 60,
        status: 'running',
        bulk_operation_id: 'gid://shopify/BulkOperation/1',
      });
      expect(running?.settings).toMatchObject({
        backfill: {
          days: 60,
          status: 'running',
          bulk_operation_id: 'gid://shopify/BulkOperation/1',
        },
      });
      expect(running?.lastSyncedAt).toEqual(afterConnect);

      const done = await repo.patchShopifyBackfillState(job, tenant.storeId, {
        status: 'done',
        orders_applied: 12,
      });
      // The second patch overwrote `status` and added a key, and kept the first patch's keys.
      expect(done?.settings).toMatchObject({
        backfill: {
          days: 60,
          status: 'done',
          bulk_operation_id: 'gid://shopify/BulkOperation/1',
          orders_applied: 12,
        },
      });
      expect(done?.lastSyncedAt?.getTime()).toBeGreaterThanOrEqual(afterConnect?.getTime() ?? 0);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('patchShopifyBackfillState keeps unrelated settings keys and is a no-op (null) with no active integration', async () => {
    const tenant = await seedTestTenant('integration-repo-backfill-state-none');
    try {
      const repo = createIntegrationRepository(db);
      const job = jobScope(tenant.organizationId, tenant.storeId);
      expect(
        await repo.patchShopifyBackfillState(job, tenant.storeId, { status: 'running' }),
      ).toBeNull();
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('patchShopifySettings merges top-level keys and keeps unrelated ones (backfill, cod_mapping)', async () => {
    const tenant = await seedTestTenant('integration-repo-settings-patch');
    try {
      const repo = createIntegrationRepository(db);
      const job = jobScope(tenant.organizationId, tenant.storeId);
      await repo.upsertShopify(job, {
        storeId: tenant.storeId,
        externalAccountId: 'gid://shopify/Shop/11',
        credentialsJson: JSON.stringify({ accessToken: 'shpat_x' }),
        scopes: ['read_orders'],
        cipher: createTestCredentialsCipher(),
      });
      await repo.patchShopifyBackfillState(job, tenant.storeId, { status: 'running', days: 60 });

      const first = await repo.patchShopifySettings(job, tenant.storeId, {
        store_key: 'pk_abcdefghijklmnopqrstuvwx',
        pixel_status: 'failed',
        pixel_error_codes: 'NO_EXTENSION',
      });
      expect(first?.settings).toMatchObject({
        store_key: 'pk_abcdefghijklmnopqrstuvwx',
        pixel_status: 'failed',
        backfill: { status: 'running', days: 60 },
      });

      const second = await repo.patchShopifySettings(job, tenant.storeId, {
        pixel_status: 'installed',
        pixel_id: 'gid://shopify/WebPixel/1',
      });
      expect(second?.settings).toMatchObject({
        store_key: 'pk_abcdefghijklmnopqrstuvwx', // survived the second patch
        pixel_status: 'installed',
        pixel_id: 'gid://shopify/WebPixel/1',
        pixel_error_codes: 'NO_EXTENSION', // a patch only overwrites the keys it names
        backfill: { status: 'running', days: 60 },
      });
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('patchShopifySettings is a no-op (null) without an active integration, and cannot cross stores', async () => {
    const tenant = await seedTestTenant('integration-repo-settings-patch-none');
    const other = await seedTestTenant('integration-repo-settings-patch-other');
    try {
      const repo = createIntegrationRepository(db);
      expect(
        await repo.patchShopifySettings(
          jobScope(tenant.organizationId, tenant.storeId),
          tenant.storeId,
          {
            pixel_status: 'installed',
          },
        ),
      ).toBeNull();
      await expect(
        repo.patchShopifySettings(jobScope(tenant.organizationId, tenant.storeId), other.storeId, {
          pixel_status: 'installed',
        }),
      ).rejects.toThrow();
    } finally {
      await cleanupTestTenant(tenant);
      await cleanupTestTenant(other);
    }
  });
});
