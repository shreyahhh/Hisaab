import type { TenantScope } from '@truepath/shared';
import { describe, expect, it } from 'vitest';
import { createSuppressedIdentityRepository } from './suppressedIdentityRepository.js';
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

const HMAC = (n: number): string => `k1:${n.toString(16).padStart(64, '0')}`;
const FUTURE = new Date(Date.now() + 400 * 86_400_000);

describe('SuppressedIdentityRepository (issue #25)', () => {
  it('countByStore is 0 before any entry, and counts entries after', async () => {
    const tenant = await seedTestTenant('suppressed-count');
    try {
      const repo = createSuppressedIdentityRepository(db);
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      expect(await repo.countByStore(scope, tenant.storeId)).toBe(0);

      await repo.add(scope, tenant.storeId, {
        identifierType: 'visitor_id',
        identifier: HMAC(1),
        reason: 'erased',
        expiresAt: FUTURE,
      });
      expect(await repo.countByStore(scope, tenant.storeId)).toBe(1);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  describe('add', () => {
    it('creates a new suppression entry', async () => {
      const tenant = await seedTestTenant('suppressed-add-new');
      try {
        const repo = createSuppressedIdentityRepository(db);
        const scope = jobScope(tenant.organizationId, tenant.storeId);
        const result = await repo.add(scope, tenant.storeId, {
          identifierType: 'identity_hash_hmac',
          identifier: HMAC(2),
          reason: 'erased',
          expiresAt: FUTURE,
        });
        expect(result.created).toBe(true);
        expect(await repo.countByStore(scope, tenant.storeId)).toBe(1);
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it('is idempotent: a repeat add for the same (type, identifier, reason) is a no-op, same id', async () => {
      const tenant = await seedTestTenant('suppressed-add-idempotent');
      try {
        const repo = createSuppressedIdentityRepository(db);
        const scope = jobScope(tenant.organizationId, tenant.storeId);
        const input = {
          identifierType: 'visitor_id' as const,
          identifier: HMAC(3),
          reason: 'erased' as const,
          expiresAt: FUTURE,
        };
        const first = await repo.add(scope, tenant.storeId, input);
        const second = await repo.add(scope, tenant.storeId, input);
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.id).toBe(first.id);
        expect(await repo.countByStore(scope, tenant.storeId)).toBe(1);
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it('the same identifier under a different reason is a distinct entry (erased vs withdrawn)', async () => {
      const tenant = await seedTestTenant('suppressed-add-reason');
      try {
        const repo = createSuppressedIdentityRepository(db);
        const scope = jobScope(tenant.organizationId, tenant.storeId);
        const identifier = HMAC(4);
        await repo.add(scope, tenant.storeId, {
          identifierType: 'visitor_id',
          identifier,
          reason: 'withdrawn',
          expiresAt: FUTURE,
        });
        const erased = await repo.add(scope, tenant.storeId, {
          identifierType: 'visitor_id',
          identifier,
          reason: 'erased',
          expiresAt: FUTURE,
        });
        expect(erased.created).toBe(true);
        expect(await repo.countByStore(scope, tenant.storeId)).toBe(2);
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it('the same identifier in a different store does not collide', async () => {
      const tenantA = await seedTestTenant('suppressed-add-store-a');
      const tenantB = await seedTestTenant('suppressed-add-store-b');
      try {
        const repo = createSuppressedIdentityRepository(db);
        const identifier = HMAC(5);
        const a = await repo.add(
          jobScope(tenantA.organizationId, tenantA.storeId),
          tenantA.storeId,
          {
            identifierType: 'visitor_id',
            identifier,
            reason: 'erased',
            expiresAt: FUTURE,
          },
        );
        const b = await repo.add(
          jobScope(tenantB.organizationId, tenantB.storeId),
          tenantB.storeId,
          {
            identifierType: 'visitor_id',
            identifier,
            reason: 'erased',
            expiresAt: FUTURE,
          },
        );
        expect(a.created).toBe(true);
        expect(b.created).toBe(true);
        expect(a.id).not.toBe(b.id);
      } finally {
        await cleanupTestTenant(tenantA);
        await cleanupTestTenant(tenantB);
      }
    });
  });
});
