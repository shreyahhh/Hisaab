import { describe, expect, it } from 'vitest';
import { resolveStoreOrganization } from './scopeResolution.js';
import { cleanupTestTenant, db, seedTestTenant } from './testing.js';

describe('resolveStoreOrganization (ADR-0016 bootstrap primitive)', () => {
  it('resolves the organization that owns a store', async () => {
    const tenant = await seedTestTenant('resolve');
    try {
      await expect(resolveStoreOrganization(db, tenant.storeId)).resolves.toBe(
        tenant.organizationId,
      );
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('returns null for an unknown store id', async () => {
    await expect(
      resolveStoreOrganization(db, '00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeNull();
  });

  it('resolves to a bare organization id string — no other store fields leak through', async () => {
    const tenant = await seedTestTenant('resolve-shape');
    try {
      const result = await resolveStoreOrganization(db, tenant.storeId);
      expect(typeof result).toBe('string');
      expect(result).toBe(tenant.organizationId);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });
});
