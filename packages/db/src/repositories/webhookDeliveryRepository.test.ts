import type { TenantScope } from '@truepath/shared';
import { describe, expect, it } from 'vitest';
import { createWebhookDeliveryRepository } from './webhookDeliveryRepository.js';
import { cleanupTestTenant, db, seedTestTenant } from '../testing.js';

function jobScope(organizationId: string, storeId: string): TenantScope {
  return {
    kind: 'tenant',
    userId: null,
    organizationId,
    role: 'job',
    storeIds: new Set([storeId]),
  };
}

describe('WebhookDeliveryRepository (shopify-integration.md §4.2/§4.3)', () => {
  it('wasAlreadyDelivered is false before recording, true after', async () => {
    const tenant = await seedTestTenant('webhook-delivery-repo-check');
    try {
      const repo = createWebhookDeliveryRepository(db);
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      const key = { storeId: tenant.storeId, webhookId: 'wh-check' };

      expect(await repo.wasAlreadyDelivered(scope, key)).toBe(false);
      await repo.recordDelivery(scope, { ...key, topic: 'app/uninstalled' });
      expect(await repo.wasAlreadyDelivered(scope, key)).toBe(true);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('records a new delivery once', async () => {
    const tenant = await seedTestTenant('webhook-delivery-repo');
    try {
      const repo = createWebhookDeliveryRepository(db);
      const result = await repo.recordDelivery(jobScope(tenant.organizationId, tenant.storeId), {
        storeId: tenant.storeId,
        webhookId: 'wh-1',
        topic: 'app/uninstalled',
      });
      expect(result.isNew).toBe(true);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('treats a replayed webhook id (same store) as not new', async () => {
    const tenant = await seedTestTenant('webhook-delivery-repo-replay');
    try {
      const repo = createWebhookDeliveryRepository(db);
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      const first = await repo.recordDelivery(scope, {
        storeId: tenant.storeId,
        webhookId: 'wh-2',
        topic: 'orders/create',
      });
      const replay = await repo.recordDelivery(scope, {
        storeId: tenant.storeId,
        webhookId: 'wh-2',
        topic: 'orders/create',
      });
      expect(first.isNew).toBe(true);
      expect(replay.isNew).toBe(false);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('the same webhook id in a different store is not a collision (dedup is per-store)', async () => {
    const tenantA = await seedTestTenant('webhook-delivery-repo-a');
    const tenantB = await seedTestTenant('webhook-delivery-repo-b');
    try {
      const repo = createWebhookDeliveryRepository(db);
      const a = await repo.recordDelivery(jobScope(tenantA.organizationId, tenantA.storeId), {
        storeId: tenantA.storeId,
        webhookId: 'shared-wh-id',
        topic: 'app/uninstalled',
      });
      const b = await repo.recordDelivery(jobScope(tenantB.organizationId, tenantB.storeId), {
        storeId: tenantB.storeId,
        webhookId: 'shared-wh-id',
        topic: 'app/uninstalled',
      });
      expect(a.isNew).toBe(true);
      expect(b.isNew).toBe(true);
    } finally {
      await cleanupTestTenant(tenantA);
      await cleanupTestTenant(tenantB);
    }
  });
});
