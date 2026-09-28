import type { TenantScope } from '@truepath/shared';
import { TenantScopeViolationError } from '@truepath/shared';
import { describe, expect, it } from 'vitest';
import { createAdAccountRepository } from './adAccountRepository.js';
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

describe('AdAccountRepository', () => {
  it('creates an account, and re-upserting the same (store, provider, externalId) updates it in place', async () => {
    const tenant = await seedTestTenant('adaccount-upsert');
    try {
      const repo = createAdAccountRepository(db);
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      const first = await repo.upsert(scope, {
        storeId: tenant.storeId,
        provider: 'meta',
        externalId: 'act_1',
        name: 'Test Account',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
      });
      const second = await repo.upsert(scope, {
        storeId: tenant.storeId,
        provider: 'meta',
        externalId: 'act_1',
        name: 'Renamed Account',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
      });
      expect(second.id).toBe(first.id);
      expect(second.name).toBe('Renamed Account');
      expect(await repo.listByStore(scope, tenant.storeId, 'meta')).toEqual([second]);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('lists only the requested provider, and only this store', async () => {
    const a = await seedTestTenant('adaccount-list-a');
    const b = await seedTestTenant('adaccount-list-b');
    try {
      const repo = createAdAccountRepository(db);
      const scopeA = jobScope(a.organizationId, a.storeId);
      await repo.upsert(scopeA, {
        storeId: a.storeId,
        provider: 'meta',
        externalId: 'act_meta',
        name: 'Meta',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
      });
      await repo.upsert(scopeA, {
        storeId: a.storeId,
        provider: 'google_ads',
        externalId: 'acct_google',
        name: 'Google',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
      });
      await repo.upsert(jobScope(b.organizationId, b.storeId), {
        storeId: b.storeId,
        provider: 'meta',
        externalId: 'act_meta',
        name: 'Other store',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
      });

      const rows = await repo.listByStore(scopeA, a.storeId, 'meta');
      expect(rows.map((r) => r.externalId)).toEqual(['act_meta']);
      expect(rows.map((r) => r.name)).toEqual(['Meta']);
    } finally {
      await cleanupTestTenant(a);
      await cleanupTestTenant(b);
    }
  });

  it('refuses a scope that does not cover the store (ADR-0016)', async () => {
    const a = await seedTestTenant('adaccount-scope-a');
    const b = await seedTestTenant('adaccount-scope-b');
    try {
      const repo = createAdAccountRepository(db);
      await expect(
        repo.upsert(jobScope(a.organizationId, a.storeId), {
          storeId: b.storeId,
          provider: 'meta',
          externalId: 'act_1',
          name: 'x',
          currency: 'INR',
          timezone: 'Asia/Kolkata',
        }),
      ).rejects.toThrow(TenantScopeViolationError);
      await expect(
        repo.listByStore(jobScope(a.organizationId, a.storeId), b.storeId, 'meta'),
      ).rejects.toThrow(TenantScopeViolationError);
    } finally {
      await cleanupTestTenant(a);
      await cleanupTestTenant(b);
    }
  });
});
