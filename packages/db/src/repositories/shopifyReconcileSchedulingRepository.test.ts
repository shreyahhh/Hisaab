import type { SystemScope, TenantScope } from '@truepath/shared';
import { describe, expect, it } from 'vitest';
import { createTestCredentialsCipher } from '@truepath/privacy/testing';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '../testing.js';
import { createIntegrationRepository } from './integrationRepository.js';
import { createShopifyReconcileSchedulingRepository } from './shopifyReconcileSchedulingRepository.js';
import { SystemScopeRequiredError } from './suppressionRebuildRepository.js';

const repo = createShopifyReconcileSchedulingRepository(db);
const system: SystemScope = { kind: 'system', reason: 'scheduler_fanout', auditId: 'test' };
const cipher = createTestCredentialsCipher();

function jobScope(t: TestTenant): TenantScope {
  return {
    kind: 'tenant',
    userId: null,
    organizationId: t.organizationId,
    role: 'job',
    storeIds: new Set([t.storeId]),
  };
}

async function connectShopify(t: TestTenant): Promise<void> {
  await createIntegrationRepository(db).upsertShopify(jobScope(t), {
    storeId: t.storeId,
    externalAccountId: `gid://shopify/Shop/${t.storeId}`,
    credentialsJson: '{}',
    scopes: ['read_orders'],
    cipher,
  });
}

describe('ShopifyReconcileSchedulingRepository.listReconcileStores', () => {
  it('lists a store with an active Shopify integration', async () => {
    const t = await seedTestTenant('reconcile-sched-active');
    try {
      await connectShopify(t);
      const rows = (await repo.listReconcileStores(system)).filter((r) => r.storeId === t.storeId);
      expect(rows).toEqual([{ storeId: t.storeId, organizationId: t.organizationId }]);
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('leaves out a store with no Shopify integration at all', async () => {
    const t = await seedTestTenant('reconcile-sched-none');
    try {
      const rows = (await repo.listReconcileStores(system)).filter((r) => r.storeId === t.storeId);
      expect(rows).toEqual([]);
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('leaves out a revoked integration', async () => {
    const t = await seedTestTenant('reconcile-sched-revoked');
    try {
      const scope = jobScope(t);
      await connectShopify(t);
      const integration = await createIntegrationRepository(db).getActiveByStore(
        scope,
        t.storeId,
        'shopify',
      );
      await createIntegrationRepository(db).revokeForOrganization(
        scope,
        t.organizationId,
        integration!.id,
      );

      const rows = (await repo.listReconcileStores(system)).filter((r) => r.storeId === t.storeId);
      expect(rows).toEqual([]);
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('refuses a TenantScope — listing across stores needs an audited SystemScope (ADR-0016)', async () => {
    const t = await seedTestTenant('reconcile-sched-scope');
    try {
      await expect(repo.listReconcileStores(jobScope(t))).rejects.toThrow(SystemScopeRequiredError);
    } finally {
      await cleanupTestTenant(t);
    }
  });
});
