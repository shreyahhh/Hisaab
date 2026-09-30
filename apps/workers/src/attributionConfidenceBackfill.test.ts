import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createOrderRepository, schema, type ApplyOrderSnapshotInput } from '@truepath/db';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '@truepath/db/testing';
import type { TenantScope } from '@truepath/shared';
import { backfillAttributionConfidence } from './attributionConfidenceBackfill.js';

function jobScope(organizationId: string, storeId: string): TenantScope {
  return {
    kind: 'tenant',
    userId: null,
    organizationId,
    role: 'job',
    storeIds: new Set([storeId]),
  };
}

function baseInput(
  storeId: string,
  overrides: Partial<ApplyOrderSnapshotInput> = {},
): ApplyOrderSnapshotInput {
  return {
    storeId,
    externalOrderId: randomUUID(),
    createdAtPlatform: new Date('2026-09-01T10:00:00Z'),
    totalAmountPaise: 100000,
    currency: 'INR',
    paymentMethod: 'prepaid',
    refundedAmountPaise: null,
    financialStatus: 'paid',
    fulfilmentStatus: 'unfulfilled',
    cancelledAt: null,
    pincodePrefix: '560',
    phoneHashHmac: null,
    emailHashHmac: null,
    landingSite: null,
    referringSite: null,
    noteAttributes: [],
    discountCodes: [],
    sourceTimestamp: new Date('2026-09-01T10:00:00Z'),
    eventStatus: 'created',
    rawRef: randomUUID(),
    ...overrides,
  };
}

const startedAt = new Date();

async function seedOrderMissingConfidence(tenant: TestTenant): Promise<string> {
  const repo = createOrderRepository(db);
  const scope = jobScope(tenant.organizationId, tenant.storeId);
  const result = await repo.applySnapshot(scope, baseInput(tenant.storeId));
  return result.orderId;
}

describe('backfillAttributionConfidence (issue #35)', () => {
  it('enqueues an attempt-2 identity-stitch job for every order missing attribution_confidence, and audits the count', async () => {
    const tenant = await seedTestTenant('attribution-confidence-backfill');
    try {
      const orderA = await seedOrderMissingConfidence(tenant);
      const orderB = await seedOrderMissingConfidence(tenant);
      // Already resolved: must not be re-enqueued.
      const orderC = await seedOrderMissingConfidence(tenant);
      await createOrderRepository(db).setAttributionConfidence(
        jobScope(tenant.organizationId, tenant.storeId),
        tenant.storeId,
        orderC,
        'high',
      );

      const add = vi.fn(async (..._a: unknown[]) => ({}) as never);
      const result = await backfillAttributionConfidence({
        db,
        stitchQueue: { add },
        storeIds: [tenant.storeId],
      });

      expect(result.enqueued).toBe(2);
      expect(add).toHaveBeenCalledTimes(2);
      const enqueuedOrderIds = add.mock.calls.map(
        (call) => (call[1] as { orderId: string }).orderId,
      );
      expect(new Set(enqueuedOrderIds)).toEqual(new Set([orderA, orderB]));
      for (const call of add.mock.calls) {
        expect(call[0]).toBe('stitch');
        expect(call[1]).toMatchObject({ storeId: tenant.storeId, attempt: 2 });
        expect((call[2] as { jobId: string }).jobId).toMatch(/^stitch:.+:2$/);
      }

      const auditRows = (await db.select().from(schema.auditLog)).filter(
        (r) => r.action === 'attribution_confidence_backfilled' && r.createdAt >= startedAt,
      );
      expect(auditRows.length).toBeGreaterThan(0);
      const latest = auditRows.sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0]!;
      expect(latest).toMatchObject({ organizationId: null, actorType: 'system' });
      expect(latest.metadata).toMatchObject({ enqueued: expect.any(Number) });

      const scopeRows = (await db.select().from(schema.auditLog)).filter(
        (r) =>
          r.action === 'system_scope_used' &&
          r.targetId === 'attribution_confidence_backfill' &&
          r.createdAt >= startedAt,
      );
      expect(scopeRows.length).toBeGreaterThan(0);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('is idempotent: a store with nothing left to backfill enqueues zero jobs', async () => {
    const tenant = await seedTestTenant('attribution-confidence-backfill-empty');
    try {
      const orderId = await seedOrderMissingConfidence(tenant);
      await createOrderRepository(db).setAttributionConfidence(
        jobScope(tenant.organizationId, tenant.storeId),
        tenant.storeId,
        orderId,
        'low',
      );

      const add = vi.fn(async (..._a: unknown[]) => ({}) as never);
      const result = await backfillAttributionConfidence({
        db,
        stitchQueue: { add },
        storeIds: [tenant.storeId],
      });

      expect(result.enqueued).toBe(0);
      expect(add).not.toHaveBeenCalled();
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('pages through more orders than fit in one page', async () => {
    const tenant = await seedTestTenant('attribution-confidence-backfill-paging');
    try {
      const orderIds = [
        await seedOrderMissingConfidence(tenant),
        await seedOrderMissingConfidence(tenant),
        await seedOrderMissingConfidence(tenant),
      ];

      const add = vi.fn(async (..._a: unknown[]) => ({}) as never);
      const result = await backfillAttributionConfidence({
        db,
        stitchQueue: { add },
        storeIds: [tenant.storeId],
        pageSize: 1,
      });

      expect(result.enqueued).toBe(3);
      const enqueuedOrderIds = add.mock.calls.map(
        (call) => (call[1] as { orderId: string }).orderId,
      );
      expect(new Set(enqueuedOrderIds)).toEqual(new Set(orderIds));
    } finally {
      await cleanupTestTenant(tenant);
    }
  });
});
