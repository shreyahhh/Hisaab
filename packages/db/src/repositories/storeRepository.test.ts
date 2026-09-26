import type { SystemScope, TenantScope } from '@truepath/shared';
import { TenantScopeViolationError } from '@truepath/shared';
import { describe, expect, it } from 'vitest';
import { createStoreRepository } from './storeRepository.js';
import { cleanupTestTenant, db, seedTestTenant } from '../testing.js';

function ownerScope(organizationId: string, storeId: string, userId: string): TenantScope {
  return { kind: 'tenant', userId, organizationId, role: 'owner', storeIds: new Set([storeId]) };
}

describe('StoreRepository (ADR-0016)', () => {
  it('lists and fetches a store that is in scope', async () => {
    const tenant = await seedTestTenant('store-repo');
    try {
      const repo = createStoreRepository(db);
      const scope = ownerScope(tenant.organizationId, tenant.storeId, tenant.userId);

      const list = await repo.listByOrganization(scope, tenant.organizationId);
      expect(list.map((s) => s.id)).toContain(tenant.storeId);

      const one = await repo.getById(scope, tenant.storeId);
      expect(one?.id).toBe(tenant.storeId);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('denies listByOrganization/getById for an org/store outside scope (SPEC §5.10 test 7)', async () => {
    const tenantA = await seedTestTenant('store-repo-a');
    const tenantB = await seedTestTenant('store-repo-b');
    try {
      const repo = createStoreRepository(db);
      const scopeA = ownerScope(tenantA.organizationId, tenantA.storeId, tenantA.userId);

      await expect(repo.listByOrganization(scopeA, tenantB.organizationId)).rejects.toThrow(
        TenantScopeViolationError,
      );
      await expect(repo.getById(scopeA, tenantB.storeId)).rejects.toThrow(
        TenantScopeViolationError,
      );
    } finally {
      await cleanupTestTenant(tenantA);
      await cleanupTestTenant(tenantB);
    }
  });

  it('allows a SystemScope to read across tenants', async () => {
    const tenant = await seedTestTenant('store-repo-sys');
    try {
      const repo = createStoreRepository(db);
      const systemScope: SystemScope = { kind: 'system', reason: 'retention', auditId: 'test' };
      const one = await repo.getById(systemScope, tenant.storeId);
      expect(one?.id).toBe(tenant.storeId);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });
});
