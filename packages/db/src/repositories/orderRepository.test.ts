import { randomUUID } from 'node:crypto';
import type { TenantScope } from '@truepath/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createOrderRepository, type ApplyOrderSnapshotInput } from './orderRepository.js';
import { cleanupTestTenant, db, seedTestTenant } from '../testing.js';
import { orderStatusEvents, orders } from '../schema/index.js';

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
    externalOrderId: '1001',
    createdAtPlatform: new Date('2026-09-01T10:00:00Z'),
    totalAmountPaise: 129900,
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

describe('OrderRepository.applySnapshot (shopify-integration.md §4.4)', () => {
  it('creates a new order on first apply', async () => {
    const t = await seedTestTenant('order-repo-create');
    try {
      const repo = createOrderRepository(db);
      const scope = jobScope(t.organizationId, t.storeId);
      const result = await repo.applySnapshot(scope, baseInput(t.storeId));
      expect(result.applied).toBe(true);
      expect(result.isNewEvent).toBe(true);

      const [row] = await db.select().from(orders).where(eq(orders.id, result.orderId));
      expect(row?.externalOrderId).toBe('1001');
      expect(row?.totalAmountPaise).toBe(129900);
      expect(row?.deliveryStatus).toBe('pending');
      expect(row?.attributionConfidence).toBeNull(); // M1-2 review item 4
      expect(row?.isFirstOrder).toBe(true);
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('a newer snapshot updates the order and records a second event', async () => {
    const t = await seedTestTenant('order-repo-update');
    try {
      const repo = createOrderRepository(db);
      const scope = jobScope(t.organizationId, t.storeId);
      const created = await repo.applySnapshot(scope, baseInput(t.storeId));

      const updated = await repo.applySnapshot(
        scope,
        baseInput(t.storeId, {
          financialStatus: 'refunded',
          totalAmountPaise: 129900,
          sourceTimestamp: new Date('2026-09-01T11:00:00Z'),
          eventStatus: 'updated',
          rawRef: randomUUID(),
        }),
      );
      expect(updated.orderId).toBe(created.orderId);
      expect(updated.applied).toBe(true);
      expect(updated.isNewEvent).toBe(true);

      const [row] = await db.select().from(orders).where(eq(orders.id, created.orderId));
      expect(row?.financialStatus).toBe('refunded');

      const events = await db
        .select()
        .from(orderStatusEvents)
        .where(eq(orderStatusEvents.orderId, created.orderId));
      expect(events).toHaveLength(2);
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('a stale (older) snapshot records the event but does not overwrite order fields', async () => {
    const t = await seedTestTenant('order-repo-stale');
    try {
      const repo = createOrderRepository(db);
      const scope = jobScope(t.organizationId, t.storeId);
      const created = await repo.applySnapshot(
        scope,
        baseInput(t.storeId, {
          financialStatus: 'paid',
          sourceTimestamp: new Date('2026-09-01T12:00:00Z'),
        }),
      );

      const stale = await repo.applySnapshot(
        scope,
        baseInput(t.storeId, {
          financialStatus: 'pending', // would be wrong if this overwrote the newer state
          sourceTimestamp: new Date('2026-09-01T09:00:00Z'), // older than what's already applied
          eventStatus: 'updated',
          rawRef: randomUUID(),
        }),
      );
      expect(stale.applied).toBe(false);
      expect(stale.isNewEvent).toBe(true); // the trail event is still recorded

      const [row] = await db.select().from(orders).where(eq(orders.id, created.orderId));
      expect(row?.financialStatus).toBe('paid'); // untouched by the stale snapshot
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('a duplicate delivery (same raw_ref) is a no-op event, applied stays true but nothing new is recorded', async () => {
    const t = await seedTestTenant('order-repo-dup');
    try {
      const repo = createOrderRepository(db);
      const scope = jobScope(t.organizationId, t.storeId);
      const rawRef = randomUUID();
      const input = baseInput(t.storeId, { rawRef });
      const first = await repo.applySnapshot(scope, input);
      const replay = await repo.applySnapshot(scope, input);

      expect(first.isNewEvent).toBe(true);
      expect(replay.isNewEvent).toBe(false);

      const events = await db
        .select()
        .from(orderStatusEvents)
        .where(eq(orderStatusEvents.orderId, first.orderId));
      expect(events).toHaveLength(1);
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('cancels a pending order when cancelled_at is set (HLD precedence)', async () => {
    const t = await seedTestTenant('order-repo-cancel');
    try {
      const repo = createOrderRepository(db);
      const scope = jobScope(t.organizationId, t.storeId);
      const created = await repo.applySnapshot(scope, baseInput(t.storeId));
      await repo.applySnapshot(
        scope,
        baseInput(t.storeId, {
          cancelledAt: new Date('2026-09-01T11:00:00Z'),
          sourceTimestamp: new Date('2026-09-01T11:00:00Z'),
          eventStatus: 'cancelled',
          rawRef: randomUUID(),
        }),
      );
      const [row] = await db.select().from(orders).where(eq(orders.id, created.orderId));
      expect(row?.deliveryStatus).toBe('cancelled');
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('does not cancel an order that is already past pending (Shiprocket owns in_transit/delivered/rto)', async () => {
    const t = await seedTestTenant('order-repo-cancel-in-transit');
    try {
      const repo = createOrderRepository(db);
      const scope = jobScope(t.organizationId, t.storeId);
      const created = await repo.applySnapshot(scope, baseInput(t.storeId));
      await db
        .update(orders)
        .set({ deliveryStatus: 'in_transit' })
        .where(eq(orders.id, created.orderId));

      await repo.applySnapshot(
        scope,
        baseInput(t.storeId, {
          cancelledAt: new Date('2026-09-01T11:00:00Z'),
          sourceTimestamp: new Date('2026-09-01T11:00:00Z'),
          eventStatus: 'cancelled',
          rawRef: randomUUID(),
        }),
      );
      const [row] = await db.select().from(orders).where(eq(orders.id, created.orderId));
      expect(row?.deliveryStatus).toBe('in_transit'); // Shopify's cancellation does not override it
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('preserves the existing refunded amount when the snapshot carries none (a REST order webhook)', async () => {
    const t = await seedTestTenant('order-repo-refund-preserve');
    try {
      const repo = createOrderRepository(db);
      const scope = jobScope(t.organizationId, t.storeId);
      const created = await repo.applySnapshot(
        scope,
        baseInput(t.storeId, { refundedAmountPaise: 5000 }),
      );
      await repo.applySnapshot(
        scope,
        baseInput(t.storeId, {
          refundedAmountPaise: null, // no totalRefunded in this snapshot
          sourceTimestamp: new Date('2026-09-01T11:00:00Z'),
          eventStatus: 'updated',
          rawRef: randomUUID(),
        }),
      );
      const [row] = await db.select().from(orders).where(eq(orders.id, created.orderId));
      expect(row?.refundedAmountPaise).toBe(5000); // untouched, not reset to 0
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('is_first_order is false when an earlier order shares the same phone hash', async () => {
    const t = await seedTestTenant('order-repo-first-order');
    try {
      const repo = createOrderRepository(db);
      const scope = jobScope(t.organizationId, t.storeId);
      const phoneHashHmac = 'k1:' + 'a'.repeat(64);
      await repo.applySnapshot(
        scope,
        baseInput(t.storeId, { externalOrderId: '1', phoneHashHmac, rawRef: randomUUID() }),
      );
      const second = await repo.applySnapshot(
        scope,
        baseInput(t.storeId, { externalOrderId: '2', phoneHashHmac, rawRef: randomUUID() }),
      );
      const [row] = await db.select().from(orders).where(eq(orders.id, second.orderId));
      expect(row?.isFirstOrder).toBe(false);
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('two concurrent first-ever deliveries for the same new order do not create two rows or lose the event trail', async () => {
    const t = await seedTestTenant('order-repo-concurrent-first');
    try {
      const repo = createOrderRepository(db);
      const scope = jobScope(t.organizationId, t.storeId);
      const inputA = baseInput(t.storeId, { rawRef: randomUUID() });
      const inputB = baseInput(t.storeId, { rawRef: randomUUID() }); // different delivery, same order

      const [resultA, resultB] = await Promise.all([
        repo.applySnapshot(scope, inputA),
        repo.applySnapshot(scope, inputB),
      ]);

      // Both calls succeed, and both resolve to the *same* order — no duplicate row.
      expect(resultA.orderId).toBe(resultB.orderId);

      const rows = await db.select().from(orders).where(eq(orders.externalOrderId, '1001'));
      const matching = rows.filter((r) => r.storeId === t.storeId);
      expect(matching).toHaveLength(1);

      // Both deliveries' distinct webhook ids are recorded — neither was silently dropped.
      const events = await db
        .select()
        .from(orderStatusEvents)
        .where(eq(orderStatusEvents.orderId, resultA.orderId));
      expect(events).toHaveLength(2);
      expect(new Set(events.map((e) => e.rawRef))).toEqual(new Set([inputA.rawRef, inputB.rawRef]));
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('two concurrent deliveries of the *identical* webhook (same raw_ref) for a brand-new order still create only one row and one event', async () => {
    const t = await seedTestTenant('order-repo-concurrent-duplicate');
    try {
      const repo = createOrderRepository(db);
      const scope = jobScope(t.organizationId, t.storeId);
      const rawRef = randomUUID();
      const input = baseInput(t.storeId, { rawRef });

      const [resultA, resultB] = await Promise.all([
        repo.applySnapshot(scope, input),
        repo.applySnapshot(scope, input),
      ]);
      expect(resultA.orderId).toBe(resultB.orderId);
      // Exactly one of the two sees isNewEvent: true; the other sees the duplicate.
      expect([resultA.isNewEvent, resultB.isNewEvent].sort()).toEqual([false, true]);

      const events = await db
        .select()
        .from(orderStatusEvents)
        .where(eq(orderStatusEvents.orderId, resultA.orderId));
      expect(events).toHaveLength(1);
    } finally {
      await cleanupTestTenant(t);
    }
  });
});

describe('OrderRepository — identity-stitching methods', () => {
  const HASH = (n: number): string => `k1:${n.toString(16).padStart(64, '0')}`;

  async function withTenant<T>(
    fn: (t: Awaited<ReturnType<typeof seedTestTenant>>, scope: TenantScope) => Promise<T>,
  ): Promise<T> {
    const tenant = await seedTestTenant('stitch-repo');
    try {
      return await fn(tenant, jobScope(tenant.organizationId, tenant.storeId));
    } finally {
      await cleanupTestTenant(tenant);
    }
  }

  it('getById finds an order in its own store, and nothing in another store', async () => {
    await withTenant(async (t, scope) => {
      const repo = createOrderRepository(db);
      const { orderId } = await repo.applySnapshot(scope, baseInput(t.storeId));
      expect((await repo.getById(scope, t.storeId, orderId))?.externalOrderId).toBe('1001');
      expect(await repo.getById(scope, t.storeId, randomUUID())).toBeNull();

      const other = await seedTestTenant('stitch-repo-other');
      try {
        // the order exists, but not in the other store: same id, different store → not found
        expect(
          await repo.getById(jobScope(other.organizationId, other.storeId), other.storeId, orderId),
        ).toBeNull();
      } finally {
        await cleanupTestTenant(other);
      }
    });
  });

  it('linkVisitorIfUnset sets the visitor once and never overwrites it', async () => {
    await withTenant(async (t, scope) => {
      const repo = createOrderRepository(db);
      const { orderId } = await repo.applySnapshot(scope, baseInput(t.storeId));
      expect(await repo.linkVisitorIfUnset(scope, t.storeId, orderId, 'visitor-1')).toBe(true);
      expect(await repo.linkVisitorIfUnset(scope, t.storeId, orderId, 'visitor-2')).toBe(false);
      expect((await repo.getById(scope, t.storeId, orderId))?.visitorId).toBe('visitor-1');
    });
  });

  it('setAttributionConfidence writes high and low, and a later match upgrades low to high', async () => {
    await withTenant(async (t, scope) => {
      const repo = createOrderRepository(db);
      const { orderId } = await repo.applySnapshot(scope, baseInput(t.storeId));
      expect((await repo.getById(scope, t.storeId, orderId))?.attributionConfidence).toBeNull();
      await repo.setAttributionConfidence(scope, t.storeId, orderId, 'low');
      expect((await repo.getById(scope, t.storeId, orderId))?.attributionConfidence).toBe('low');
      await repo.setAttributionConfidence(scope, t.storeId, orderId, 'high');
      expect((await repo.getById(scope, t.storeId, orderId))?.attributionConfidence).toBe('high');
    });
  });

  it('countOrdersByIdentityHash counts phone or email matches inside the window, in this store only', async () => {
    await withTenant(async (t, scope) => {
      const repo = createOrderRepository(db);
      const at = (day: number) => new Date(`2026-09-${String(day).padStart(2, '0')}T10:00:00Z`);
      await repo.applySnapshot(
        scope,
        baseInput(t.storeId, {
          externalOrderId: 'a',
          createdAtPlatform: at(20),
          phoneHashHmac: HASH(1) as never,
        }),
      );
      await repo.applySnapshot(
        scope,
        baseInput(t.storeId, {
          externalOrderId: 'b',
          createdAtPlatform: at(21),
          emailHashHmac: HASH(1) as never,
        }),
      );
      await repo.applySnapshot(
        scope,
        baseInput(t.storeId, {
          externalOrderId: 'c',
          createdAtPlatform: at(1),
          phoneHashHmac: HASH(1) as never,
        }),
      ); // before the window
      await repo.applySnapshot(
        scope,
        baseInput(t.storeId, {
          externalOrderId: 'd',
          createdAtPlatform: at(22),
          phoneHashHmac: HASH(2) as never,
        }),
      );

      expect(await repo.countOrdersByIdentityHash(scope, t.storeId, HASH(1), at(10))).toBe(2);
      expect(await repo.countOrdersByIdentityHash(scope, t.storeId, HASH(1), at(1))).toBe(3);
      expect(await repo.countOrdersByIdentityHash(scope, t.storeId, HASH(3), at(1))).toBe(0);

      const other = await seedTestTenant('stitch-repo-other2');
      try {
        expect(
          await repo.countOrdersByIdentityHash(
            jobScope(other.organizationId, other.storeId),
            other.storeId,
            HASH(1),
            at(1),
          ),
        ).toBe(0);
      } finally {
        await cleanupTestTenant(other);
      }
    });
  });
});
