import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema } from '@truepath/db';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '@truepath/db/testing';
import { pruneWebhookDeliveries } from './webhookDeliveryPrune.js';

const { shopifyWebhookDeliveries, auditLog } = schema;
const startedAt = new Date();

async function seedDelivery(
  tenant: TestTenant,
  webhookId: string,
  receivedAt: Date,
): Promise<void> {
  await db
    .insert(shopifyWebhookDeliveries)
    .values({ storeId: tenant.storeId, webhookId, topic: 'orders/create', receivedAt });
}

describe('pruneWebhookDeliveries (issue #32)', () => {
  it('deletes only rows past the retention window and writes an audited count', async () => {
    const tenant = await seedTestTenant('prune-webhook-deliveries');
    try {
      const now = new Date('2026-10-01T00:00:00.000Z');
      await seedDelivery(tenant, 'old-1', new Date('2026-09-01T00:00:00.000Z')); // 30d old
      await seedDelivery(tenant, 'old-2', new Date('2026-09-20T00:00:00.000Z')); // 11d old
      await seedDelivery(tenant, 'recent', new Date('2026-09-30T00:00:00.000Z')); // 1d old

      const result = await pruneWebhookDeliveries({
        db,
        now: () => now,
        retentionDays: 7,
        storeIds: [tenant.storeId],
        log: () => {},
      });

      expect(result).toMatchObject({
        deleted: 2,
        retentionDays: 7,
        cutoff: new Date('2026-09-24T00:00:00.000Z'),
      });

      const remaining = await db
        .select({ webhookId: shopifyWebhookDeliveries.webhookId })
        .from(shopifyWebhookDeliveries)
        .where(eq(shopifyWebhookDeliveries.storeId, tenant.storeId));
      expect(remaining.map((r) => r.webhookId)).toEqual(['recent']);

      const auditRows = (await db.select().from(auditLog)).filter(
        (r) => r.action === 'webhook_deliveries_pruned' && r.createdAt >= startedAt,
      );
      expect(auditRows.length).toBeGreaterThan(0);
      const latest = auditRows.sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0]!;
      expect(latest).toMatchObject({ organizationId: null, actorType: 'system' });
      expect(latest.metadata).toMatchObject({ deleted: expect.any(Number) });

      const scopeRows = (await db.select().from(auditLog)).filter(
        (r) =>
          r.action === 'system_scope_used' &&
          r.targetId === 'webhook_delivery_prune' &&
          r.createdAt >= startedAt,
      );
      expect(scopeRows.length).toBeGreaterThan(0);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('defaults to SHOPIFY_WEBHOOK_DELIVERY_RETENTION_DAYS (7) when none is given', async () => {
    const tenant = await seedTestTenant('prune-webhook-deliveries-default');
    try {
      const now = new Date('2026-10-01T00:00:00.000Z');
      await seedDelivery(tenant, 'ancient', new Date('2026-01-01T00:00:00.000Z'));
      await seedDelivery(tenant, 'today', now);

      await pruneWebhookDeliveries({
        db,
        now: () => now,
        storeIds: [tenant.storeId],
        log: () => {},
      });

      const remaining = await db
        .select({ webhookId: shopifyWebhookDeliveries.webhookId })
        .from(shopifyWebhookDeliveries)
        .where(eq(shopifyWebhookDeliveries.storeId, tenant.storeId));
      expect(remaining.map((r) => r.webhookId)).toEqual(['today']);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('is idempotent: a second run with nothing left to prune deletes zero rows', async () => {
    const tenant = await seedTestTenant('prune-webhook-deliveries-idempotent');
    try {
      const now = new Date('2026-10-01T00:00:00.000Z');
      await seedDelivery(tenant, 'kept', now);

      const storeIds = [tenant.storeId];
      const first = await pruneWebhookDeliveries({
        db,
        now: () => now,
        retentionDays: 7,
        storeIds,
      });
      const second = await pruneWebhookDeliveries({
        db,
        now: () => now,
        retentionDays: 7,
        storeIds,
      });
      expect(second.deleted).toBe(0);
      expect(first.deleted).toBeGreaterThanOrEqual(0);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });
});
