import { randomUUID } from 'node:crypto';
import type { TenantScope } from '@truepath/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createCapiDispatchLogRepository } from './capiDispatchLogRepository.js';
import { createOrderRepository, type ApplyOrderSnapshotInput } from './orderRepository.js';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '../testing.js';
import { capiDispatchLog } from '../schema/index.js';

function jobScope(organizationId: string, storeId: string): TenantScope {
  return {
    kind: 'tenant',
    userId: null,
    organizationId,
    role: 'job',
    storeIds: new Set([storeId]),
  };
}

function baseOrderInput(storeId: string, externalOrderId: string): ApplyOrderSnapshotInput {
  return {
    storeId,
    externalOrderId,
    createdAtPlatform: new Date(),
    totalAmountPaise: 1000,
    currency: 'INR',
    paymentMethod: 'cod',
    refundedAmountPaise: null,
    financialStatus: null,
    fulfilmentStatus: 'unfulfilled',
    cancelledAt: null,
    pincodePrefix: null,
    phoneHashHmac: null,
    emailHashHmac: null,
    landingSite: null,
    referringSite: null,
    noteAttributes: [],
    discountCodes: [],
    sourceTimestamp: new Date(),
    eventStatus: 'created',
    rawRef: randomUUID(),
  };
}

async function seedDispatchRow(
  tenant: TestTenant,
  orderId: string,
  lastError: string | null,
): Promise<void> {
  await db.insert(capiDispatchLog).values({
    storeId: tenant.storeId,
    orderId,
    eventName: 'DeliveredPurchase',
    eventId: `delivered_${orderId}`,
    status: lastError ? 'failed' : 'sent',
    lastError,
  });
}

describe('CapiDispatchLogRepository.redactLastErrorForOrders (issue #25)', () => {
  it('redacts last_error for the given orders only', async () => {
    const tenant = await seedTestTenant('capi-redact');
    try {
      const orders = createOrderRepository(db);
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      const target = await orders.applySnapshot(scope, baseOrderInput(tenant.storeId, 't1'));
      const untouched = await orders.applySnapshot(scope, baseOrderInput(tenant.storeId, 't2'));
      await seedDispatchRow(tenant, target.orderId, 'Meta said: invalid hashed email abc123');
      await seedDispatchRow(tenant, untouched.orderId, 'some other error');

      const repo = createCapiDispatchLogRepository(db);
      const result = await repo.redactLastErrorForOrders(scope, tenant.storeId, [target.orderId]);
      expect(result.redacted).toBe(1);

      const rows = await db
        .select({ orderId: capiDispatchLog.orderId, lastError: capiDispatchLog.lastError })
        .from(capiDispatchLog)
        .where(eq(capiDispatchLog.storeId, tenant.storeId));
      const byOrder = new Map(rows.map((r) => [r.orderId, r.lastError]));
      expect(byOrder.get(target.orderId)).toBeNull();
      expect(byOrder.get(untouched.orderId)).toBe('some other error');
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('is a no-op for an order with no last_error (nothing to redact)', async () => {
    const tenant = await seedTestTenant('capi-redact-clean');
    try {
      const orders = createOrderRepository(db);
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      const order = await orders.applySnapshot(scope, baseOrderInput(tenant.storeId, 'c1'));
      await seedDispatchRow(tenant, order.orderId, null);

      const repo = createCapiDispatchLogRepository(db);
      const result = await repo.redactLastErrorForOrders(scope, tenant.storeId, [order.orderId]);
      expect(result.redacted).toBe(0);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('is a no-op for an empty orderIds list', async () => {
    const tenant = await seedTestTenant('capi-redact-empty');
    try {
      const repo = createCapiDispatchLogRepository(db);
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      expect(await repo.redactLastErrorForOrders(scope, tenant.storeId, [])).toEqual({
        redacted: 0,
      });
    } finally {
      await cleanupTestTenant(tenant);
    }
  });
});
