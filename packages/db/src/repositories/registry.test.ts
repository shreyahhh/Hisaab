import type { TenantScope } from '@truepath/shared';
import { TenantScopeViolationError } from '@truepath/shared';
import { describe, expect, it } from 'vitest';
import { repositoryRegistry } from './registry.js';
import { cleanupTestTenant, db, seedTestTenant } from '../testing.js';

// Generated, not hand-maintained per method (SPEC §5.10 test 7; auth-tenancy.md §8): iterates
// every repository registered in repositoryRegistry so a repository added without updating this
// file is still covered — only a missing registry entry opts a repository out.
describe('repositoryRegistry — generated cross-tenant check', () => {
  for (const repo of repositoryRegistry) {
    for (const method of repo.methods) {
      it(`${repo.name}.${method.name} denies a scope that does not cover the requested ${method.scopeKind}`, async () => {
        const tenantA = await seedTestTenant('registry-a');
        const tenantB = await seedTestTenant('registry-b');
        try {
          const scopeA: TenantScope = {
            kind: 'tenant',
            userId: tenantA.userId,
            organizationId: tenantA.organizationId,
            role: 'owner',
            storeIds: new Set([tenantA.storeId]),
          };
          const foreignResourceId =
            method.scopeKind === 'store' ? tenantB.storeId : tenantB.organizationId;

          await expect(method.invoke(db, scopeA, foreignResourceId)).rejects.toThrow(
            TenantScopeViolationError,
          );
        } finally {
          await cleanupTestTenant(tenantA);
          await cleanupTestTenant(tenantB);
        }
      });
    }
  }
});
