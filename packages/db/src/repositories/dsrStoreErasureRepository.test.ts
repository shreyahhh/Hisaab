import { eq } from 'drizzle-orm';
import type { TenantScope } from '@truepath/shared';
import { describe, expect, it } from 'vitest';
import { createDsrStoreErasureRepository } from './dsrStoreErasureRepository.js';
import {
  adAccounts,
  attributionSettings,
  channelRules,
  consentRecords,
  integrations,
  orderStatusEvents,
  orders,
  suppressedIdentities,
} from '../schema/index.js';
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

async function seedEverything(storeId: string) {
  const [order] = await db
    .insert(orders)
    .values({
      storeId,
      externalOrderId: 'store-erasure-1',
      createdAtPlatform: new Date(),
      totalAmountPaise: 100000,
      currency: 'INR',
      paymentMethod: 'cod',
    })
    .returning();
  await db.insert(orderStatusEvents).values({
    orderId: order!.id,
    source: 'shopify',
    status: 'created',
    occurredAt: new Date(),
  });
  await db.insert(consentRecords).values({
    id: crypto.randomUUID(),
    storeId,
    visitorId: 'k1:' + 'a'.repeat(64),
    purposes: ['attribution_analytics'],
    state: 'granted',
    noticeVersion: 'v1',
    source: 'pixel_initial_state',
    occurredAt: new Date(),
  });
  await db.insert(channelRules).values({
    storeId,
    priority: 1,
    match: {},
    channel: 'direct',
  });
  await db.insert(attributionSettings).values({
    storeId,
    defaultModel: 'last_click',
  });
  await db.insert(adAccounts).values({
    storeId,
    provider: 'meta',
    externalId: 'act_123',
    name: 'Test account',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
  });
  await db.insert(integrations).values({
    storeId,
    provider: 'shopify',
    status: 'active',
  });
  await db.insert(suppressedIdentities).values({
    storeId,
    identifierType: 'visitor_id',
    identifier: 'k1:' + 'b'.repeat(64),
    reason: 'erased',
    expiresAt: new Date(Date.now() + 400 * 86_400_000),
  });

  return { orderId: order!.id };
}

describe('DsrStoreErasureRepository (issue #25, privacy-dpdp.md §4.7 step 3)', () => {
  it('deletes every store-scoped table, cascading order_status_events, and returns per-table counts', async () => {
    const tenant = await seedTestTenant('store-erasure-everything');
    try {
      const { orderId } = await seedEverything(tenant.storeId);
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      const repo = createDsrStoreErasureRepository(db);

      const result = await repo.eraseStore(scope, tenant.storeId);
      expect(result).toEqual({
        orders: 1,
        consentRecords: 1,
        channelRules: 1,
        attributionSettings: 1,
        adAccounts: 1,
        integrations: 1,
        suppressedIdentities: 1,
      });

      expect(await db.select().from(orders).where(eq(orders.storeId, tenant.storeId))).toEqual([]);
      expect(
        await db.select().from(orderStatusEvents).where(eq(orderStatusEvents.orderId, orderId)),
      ).toEqual([]); // cascaded via orders' ON DELETE CASCADE
      expect(
        await db.select().from(consentRecords).where(eq(consentRecords.storeId, tenant.storeId)),
      ).toEqual([]);
      expect(
        await db.select().from(channelRules).where(eq(channelRules.storeId, tenant.storeId)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(attributionSettings)
          .where(eq(attributionSettings.storeId, tenant.storeId)),
      ).toEqual([]);
      expect(
        await db.select().from(adAccounts).where(eq(adAccounts.storeId, tenant.storeId)),
      ).toEqual([]);
      expect(
        await db.select().from(integrations).where(eq(integrations.storeId, tenant.storeId)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(suppressedIdentities)
          .where(eq(suppressedIdentities.storeId, tenant.storeId)),
      ).toEqual([]);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('is idempotent: a second call deletes nothing and returns all-zero counts', async () => {
    const tenant = await seedTestTenant('store-erasure-idempotent');
    try {
      await seedEverything(tenant.storeId);
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      const repo = createDsrStoreErasureRepository(db);

      await repo.eraseStore(scope, tenant.storeId);
      const second = await repo.eraseStore(scope, tenant.storeId);
      expect(second).toEqual({
        orders: 0,
        consentRecords: 0,
        channelRules: 0,
        attributionSettings: 0,
        adAccounts: 0,
        integrations: 0,
        suppressedIdentities: 0,
      });
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it("never touches another store's rows", async () => {
    const tenantA = await seedTestTenant('store-erasure-a');
    const tenantB = await seedTestTenant('store-erasure-b');
    try {
      await seedEverything(tenantA.storeId);
      await seedEverything(tenantB.storeId);
      const scopeA = jobScope(tenantA.organizationId, tenantA.storeId);
      await createDsrStoreErasureRepository(db).eraseStore(scopeA, tenantA.storeId);

      expect(
        await db.select().from(orders).where(eq(orders.storeId, tenantB.storeId)),
      ).toHaveLength(1);
      expect(
        await db.select().from(integrations).where(eq(integrations.storeId, tenantB.storeId)),
      ).toHaveLength(1);
    } finally {
      await cleanupTestTenant(tenantA);
      await cleanupTestTenant(tenantB);
    }
  });
});
