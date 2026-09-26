import { eq } from 'drizzle-orm';
import { TenantScopeViolationError, type SystemScope, type TenantScope } from '@truepath/shared';
import { describe, expect, it } from 'vitest';
import { dpaAcceptances } from '../schema/index.js';
import { createDpaAcceptanceRepository } from './dpaAcceptanceRepository.js';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '../testing.js';

function ownerScope(tenant: TestTenant): TenantScope {
  return {
    kind: 'tenant',
    userId: tenant.userId,
    organizationId: tenant.organizationId,
    role: 'owner',
    storeIds: new Set([tenant.storeId]),
  };
}

function input(tenant: TestTenant, dpaVersion: string, ipTruncated: string | null = null) {
  return {
    organizationId: tenant.organizationId,
    dpaVersion,
    acceptedByUserId: tenant.userId,
    ipTruncated,
  };
}

async function rowCount(organizationId: string): Promise<number> {
  const rows = await db
    .select({ id: dpaAcceptances.id })
    .from(dpaAcceptances)
    .where(eq(dpaAcceptances.organizationId, organizationId));
  return rows.length;
}

describe('DpaAcceptanceRepository (ADR-0016)', () => {
  it('records an acceptance with its version, user and truncated IP', async () => {
    const tenant = await seedTestTenant('dpa-repo-record');
    try {
      const repo = createDpaAcceptanceRepository(db);
      const { row, created } = await repo.record(
        ownerScope(tenant),
        input(tenant, 'v1', '203.0.113.0/24'),
      );

      expect(created).toBe(true);
      expect(row).toMatchObject({
        organizationId: tenant.organizationId,
        dpaVersion: 'v1',
        acceptedByUserId: tenant.userId,
        ipTruncated: '203.0.113.0/24',
      });
      expect(row.acceptedAt).toBeInstanceOf(Date);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('is idempotent: recording the same version again returns the first row and writes nothing', async () => {
    const tenant = await seedTestTenant('dpa-repo-idempotent');
    try {
      const repo = createDpaAcceptanceRepository(db);
      const first = await repo.record(ownerScope(tenant), input(tenant, 'v1', '203.0.113.0/24'));
      const second = await repo.record(ownerScope(tenant), input(tenant, 'v1', '198.51.100.0/24'));

      expect(second.created).toBe(false);
      expect(second.row.id).toBe(first.row.id);
      // The original evidence is kept as it was, not overwritten by the repeat.
      expect(second.row.ipTruncated).toBe('203.0.113.0/24');
      expect(await rowCount(tenant.organizationId)).toBe(1);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('two concurrent accepts of one version leave exactly one row and exactly one "created"', async () => {
    const tenant = await seedTestTenant('dpa-repo-race');
    try {
      const repo = createDpaAcceptanceRepository(db);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => repo.record(ownerScope(tenant), input(tenant, 'v1'))),
      );

      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.row.id)).size).toBe(1);
      expect(await rowCount(tenant.organizationId)).toBe(1);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('keeps versions apart: an older acceptance does not satisfy a newer version', async () => {
    const tenant = await seedTestTenant('dpa-repo-versions');
    try {
      const repo = createDpaAcceptanceRepository(db);
      const scope = ownerScope(tenant);
      await repo.record(scope, input(tenant, 'v1'));

      expect(await repo.findForVersion(scope, tenant.organizationId, 'v1')).not.toBeNull();
      expect(await repo.findForVersion(scope, tenant.organizationId, 'v2')).toBeNull();

      const v2 = await repo.record(scope, input(tenant, 'v2'));
      expect(v2.created).toBe(true);
      expect(await rowCount(tenant.organizationId)).toBe(2);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it("does not see another organization's acceptance of the same version", async () => {
    const tenantA = await seedTestTenant('dpa-repo-a');
    const tenantB = await seedTestTenant('dpa-repo-b');
    try {
      const repo = createDpaAcceptanceRepository(db);
      await repo.record(ownerScope(tenantB), input(tenantB, 'v1'));

      // A has not accepted, whatever B has done.
      expect(
        await repo.findForVersion(ownerScope(tenantA), tenantA.organizationId, 'v1'),
      ).toBeNull();
      const a = await repo.record(ownerScope(tenantA), input(tenantA, 'v1'));
      expect(a.created).toBe(true);
    } finally {
      await cleanupTestTenant(tenantA);
      await cleanupTestTenant(tenantB);
    }
  });

  it("denies record/findForVersion outside the caller's organization, and writes nothing (SPEC §5.10 test 7)", async () => {
    const tenantA = await seedTestTenant('dpa-repo-deny-a');
    const tenantB = await seedTestTenant('dpa-repo-deny-b');
    try {
      const repo = createDpaAcceptanceRepository(db);
      const scopeA = ownerScope(tenantA);

      await expect(
        repo.record(scopeA, { ...input(tenantB, 'v1'), acceptedByUserId: tenantA.userId }),
      ).rejects.toThrow(TenantScopeViolationError);
      await expect(repo.findForVersion(scopeA, tenantB.organizationId, 'v1')).rejects.toThrow(
        TenantScopeViolationError,
      );
      expect(await rowCount(tenantB.organizationId)).toBe(0);
    } finally {
      await cleanupTestTenant(tenantA);
      await cleanupTestTenant(tenantB);
    }
  });

  it('refuses to record an acceptance on behalf of another user, or from a system scope', async () => {
    const tenant = await seedTestTenant('dpa-repo-behalf');
    const other = await seedTestTenant('dpa-repo-behalf-other');
    try {
      const repo = createDpaAcceptanceRepository(db);
      await expect(
        repo.record(ownerScope(tenant), { ...input(tenant, 'v1'), acceptedByUserId: other.userId }),
      ).rejects.toThrow(/signed-in user/);

      const systemScope: SystemScope = { kind: 'system', reason: 'retention', auditId: 'test' };
      await expect(repo.record(systemScope, input(tenant, 'v1'))).rejects.toThrow(/signed-in user/);

      expect(await rowCount(tenant.organizationId)).toBe(0);
    } finally {
      await cleanupTestTenant(tenant);
      await cleanupTestTenant(other);
    }
  });

  it('commits or rolls back with the surrounding transaction', async () => {
    const tenant = await seedTestTenant('dpa-repo-tx');
    try {
      const scope = ownerScope(tenant);
      await expect(
        db.transaction(async (tx) => {
          await createDpaAcceptanceRepository(tx).record(scope, input(tenant, 'v1'));
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await rowCount(tenant.organizationId)).toBe(0);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });
});
