import { eq } from 'drizzle-orm';
import type { SystemScope, TenantScope } from '@truepath/shared';
import { describe, expect, it } from 'vitest';
import { createWebhookDeliveryRepository } from './webhookDeliveryRepository.js';
import { SystemScopeRequiredError } from './suppressionRebuildRepository.js';
import { cleanupTestTenant, db, seedTestTenant } from '../testing.js';
import { shopifyWebhookDeliveries } from '../schema/index.js';

const SYSTEM_SCOPE: SystemScope = {
  kind: 'system',
  reason: 'webhook_delivery_prune',
  auditId: 'test',
};

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

  describe('pruneOlderThan (issue #32)', () => {
    it('deletes only rows older than the cutoff, across stores, and requires a SystemScope', async () => {
      const tenantA = await seedTestTenant('webhook-delivery-prune-a');
      const tenantB = await seedTestTenant('webhook-delivery-prune-b');
      try {
        const repo = createWebhookDeliveryRepository(db);
        await db.insert(shopifyWebhookDeliveries).values([
          {
            storeId: tenantA.storeId,
            webhookId: 'old-a',
            topic: 'orders/create',
            receivedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
          {
            storeId: tenantB.storeId,
            webhookId: 'old-b',
            topic: 'orders/create',
            receivedAt: new Date('2026-01-02T00:00:00.000Z'),
          },
          {
            storeId: tenantA.storeId,
            webhookId: 'recent-a',
            topic: 'orders/create',
            receivedAt: new Date('2026-09-30T00:00:00.000Z'),
          },
        ]);

        const cutoff = new Date('2026-09-01T00:00:00.000Z');
        const storeIds = [tenantA.storeId, tenantB.storeId];
        const rejected = jobScope(tenantA.organizationId, tenantA.storeId);
        await expect(repo.pruneOlderThan(rejected, cutoff, storeIds)).rejects.toThrow(
          SystemScopeRequiredError,
        );

        // Scoped to this test's own stores: other test files' rows (run concurrently against the
        // same Postgres, CLAUDE.md's real-services rule) are never touched by this sweep.
        const result = await repo.pruneOlderThan(SYSTEM_SCOPE, cutoff, storeIds);
        expect(result.deleted).toBe(2);

        const remaining = await db
          .select({ webhookId: shopifyWebhookDeliveries.webhookId })
          .from(shopifyWebhookDeliveries)
          .where(eq(shopifyWebhookDeliveries.storeId, tenantA.storeId));
        expect(remaining.map((r) => r.webhookId)).toEqual(['recent-a']);

        // Idempotent: nothing left to delete a second time.
        expect((await repo.pruneOlderThan(SYSTEM_SCOPE, cutoff, storeIds)).deleted).toBe(0);
      } finally {
        await cleanupTestTenant(tenantA);
        await cleanupTestTenant(tenantB);
      }
    });
  });
});
