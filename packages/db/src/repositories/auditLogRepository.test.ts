import type { TenantScope } from '@truepath/shared';
import { TenantScopeViolationError } from '@truepath/shared';
import { describe, expect, it } from 'vitest';
import { createAuditLogRepository } from './auditLogRepository.js';
import { cleanupTestTenant, db, seedTestTenant } from '../testing.js';

function ownerScope(organizationId: string, storeId: string, userId: string): TenantScope {
  return { kind: 'tenant', userId, organizationId, role: 'owner', storeIds: new Set([storeId]) };
}

describe('AuditLogRepository (ADR-0016, SPEC S-4)', () => {
  it('records and lists an entry for the organization in scope', async () => {
    const tenant = await seedTestTenant('audit-repo');
    try {
      const repo = createAuditLogRepository(db);
      const scope = ownerScope(tenant.organizationId, tenant.storeId, tenant.userId);

      await repo.record(scope, {
        organizationId: tenant.organizationId,
        actorUserId: tenant.userId,
        actorType: 'user',
        action: 'login_succeeded',
        targetType: 'user',
        targetId: tenant.userId,
      });

      const entries = await repo.listByOrganization(scope, tenant.organizationId);
      expect(entries.some((e) => e.action === 'login_succeeded')).toBe(true);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('denies record/listByOrganization for an org outside scope (SPEC §5.10 test 7)', async () => {
    const tenantA = await seedTestTenant('audit-repo-a');
    const tenantB = await seedTestTenant('audit-repo-b');
    try {
      const repo = createAuditLogRepository(db);
      const scopeA = ownerScope(tenantA.organizationId, tenantA.storeId, tenantA.userId);

      await expect(
        repo.record(scopeA, {
          organizationId: tenantB.organizationId,
          actorType: 'user',
          action: 'login_succeeded',
          targetType: 'user',
          targetId: tenantB.userId,
        }),
      ).rejects.toThrow(TenantScopeViolationError);

      await expect(repo.listByOrganization(scopeA, tenantB.organizationId)).rejects.toThrow(
        TenantScopeViolationError,
      );
    } finally {
      await cleanupTestTenant(tenantA);
      await cleanupTestTenant(tenantB);
    }
  });

  it('recordGlobal writes a platform-wide entry (organization_id=null) with no scope needed', async () => {
    await expect(
      createAuditLogRepository(db).recordGlobal({
        actorType: 'system',
        action: 'retention_run',
        targetType: 'platform',
        targetId: 'platform',
      }),
    ).resolves.toBeUndefined();
  });
});
