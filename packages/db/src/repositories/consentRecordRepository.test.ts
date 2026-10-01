import { randomUUID } from 'node:crypto';
import type { TenantScope } from '@truepath/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createConsentRecordRepository } from './consentRecordRepository.js';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '../testing.js';
import { consentRecords } from '../schema/index.js';

function jobScope(organizationId: string, storeId: string): TenantScope {
  return {
    kind: 'tenant',
    userId: null,
    organizationId,
    role: 'job',
    storeIds: new Set([storeId]),
  };
}

// id = source event_id (HLD §8), so tests supply it explicitly rather than relying on a default.
async function seedConsentRow(
  tenant: TestTenant,
  visitorHmac: string,
  state: 'granted' | 'withdrawn' = 'granted',
): Promise<string> {
  const id = randomUUID();
  await db.insert(consentRecords).values({
    id,
    storeId: tenant.storeId,
    visitorId: visitorHmac,
    purposes: ['attribution_analytics'],
    state,
    noticeVersion: 'v1',
    source: 'pixel_initial_state',
    occurredAt: new Date(),
  });
  return id;
}

const HMAC = (n: number): string => `k1:${n.toString(16).padStart(64, '0')}`;

describe('ConsentRecordRepository', () => {
  it("listRecentByStore returns the store's own rows, newest first", async () => {
    const tenant = await seedTestTenant('consent-list');
    try {
      const repo = createConsentRecordRepository(db);
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      await seedConsentRow(tenant, HMAC(1));
      await seedConsentRow(tenant, HMAC(2));

      const rows = await repo.listRecentByStore(scope, tenant.storeId, 20);
      expect(rows).toHaveLength(2);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  describe('deleteByVisitorHmacs (issue #25)', () => {
    it('deletes only the rows for the given visitor HMACs', async () => {
      const tenant = await seedTestTenant('consent-delete');
      try {
        const repo = createConsentRecordRepository(db);
        const scope = jobScope(tenant.organizationId, tenant.storeId);
        await seedConsentRow(tenant, HMAC(10));
        await seedConsentRow(tenant, HMAC(11));
        await seedConsentRow(tenant, HMAC(12)); // untouched

        const result = await repo.deleteByVisitorHmacs(scope, tenant.storeId, [HMAC(10), HMAC(11)]);
        expect(result.deleted).toBe(2);

        const remaining = await db
          .select({ visitorId: consentRecords.visitorId })
          .from(consentRecords)
          .where(eq(consentRecords.storeId, tenant.storeId));
        expect(remaining.map((r) => r.visitorId)).toEqual([HMAC(12)]);
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it('is a no-op for an empty list, with no query at all', async () => {
      const tenant = await seedTestTenant('consent-delete-empty');
      try {
        const repo = createConsentRecordRepository(db);
        const scope = jobScope(tenant.organizationId, tenant.storeId);
        await seedConsentRow(tenant, HMAC(20));
        expect(await repo.deleteByVisitorHmacs(scope, tenant.storeId, [])).toEqual({ deleted: 0 });
        expect((await repo.listRecentByStore(scope, tenant.storeId, 20)).length).toBe(1);
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it("never deletes another store's row for the same HMAC", async () => {
      const tenantA = await seedTestTenant('consent-delete-a');
      const tenantB = await seedTestTenant('consent-delete-b');
      try {
        const repo = createConsentRecordRepository(db);
        const sharedHmac = HMAC(30);
        await seedConsentRow(tenantA, sharedHmac);
        await seedConsentRow(tenantB, sharedHmac);

        await repo.deleteByVisitorHmacs(
          jobScope(tenantA.organizationId, tenantA.storeId),
          tenantA.storeId,
          [sharedHmac],
        );

        const bRows = await repo.listRecentByStore(
          jobScope(tenantB.organizationId, tenantB.storeId),
          tenantB.storeId,
          20,
        );
        expect(bRows).toHaveLength(1);
      } finally {
        await cleanupTestTenant(tenantA);
        await cleanupTestTenant(tenantB);
      }
    });
  });
});
