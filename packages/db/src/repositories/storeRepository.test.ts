import { eq } from 'drizzle-orm';
import type { SystemScope, TenantScope } from '@truepath/shared';
import { TenantScopeViolationError } from '@truepath/shared';
import { describe, expect, it } from 'vitest';
import { stores } from '../schema/index.js';
import { createStoreRepository, ShopLinkedToAnotherOrganizationError } from './storeRepository.js';
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

  describe('upsertByShopDomain (shopify-integration.md §4.1 step 4)', () => {
    it('creates a new store for a shop domain nobody has connected yet', async () => {
      const tenant = await seedTestTenant('store-repo-upsert-create');
      try {
        const repo = createStoreRepository(db);
        const scope = ownerScope(tenant.organizationId, tenant.storeId, tenant.userId);
        const shopDomain = `new-shop-${Date.now()}.myshopify.com`;

        const created = await repo.upsertByShopDomain(scope, {
          organizationId: tenant.organizationId,
          shopDomain,
        });
        expect(created.shopDomain).toBe(shopDomain);
        expect(created.status).toBe('active');
        expect(created.organizationId).toBe(tenant.organizationId);
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it('reactivates the same org’s existing store on a re-auth, without creating a second row', async () => {
      const tenant = await seedTestTenant('store-repo-upsert-reauth');
      try {
        const repo = createStoreRepository(db);
        const scope = ownerScope(tenant.organizationId, tenant.storeId, tenant.userId);
        const shopDomain = `reauth-shop-${Date.now()}.myshopify.com`;

        const first = await repo.upsertByShopDomain(scope, {
          organizationId: tenant.organizationId,
          shopDomain,
        });
        const second = await repo.upsertByShopDomain(scope, {
          organizationId: tenant.organizationId,
          shopDomain,
          currency: 'INR',
        });
        expect(second.id).toBe(first.id);
        expect(second.installedAt?.getTime()).toBe(first.installedAt?.getTime());
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it('throws ShopLinkedToAnotherOrganizationError when the shop belongs to a different org', async () => {
      const tenantA = await seedTestTenant('store-repo-upsert-a');
      const tenantB = await seedTestTenant('store-repo-upsert-b');
      try {
        const repo = createStoreRepository(db);
        const shopDomain = `contested-shop-${Date.now()}.myshopify.com`;
        await repo.upsertByShopDomain(
          ownerScope(tenantA.organizationId, tenantA.storeId, tenantA.userId),
          {
            organizationId: tenantA.organizationId,
            shopDomain,
          },
        );

        await expect(
          repo.upsertByShopDomain(
            ownerScope(tenantB.organizationId, tenantB.storeId, tenantB.userId),
            {
              organizationId: tenantB.organizationId,
              shopDomain,
            },
          ),
        ).rejects.toThrow(ShopLinkedToAnotherOrganizationError);
      } finally {
        await cleanupTestTenant(tenantA);
        await cleanupTestTenant(tenantB);
      }
    });

    it('markUninstalled marks the store uninstalled once, and is a no-op on a retried webhook', async () => {
      const tenant = await seedTestTenant('store-repo-uninstall');
      try {
        const repo = createStoreRepository(db);
        const jobScope: TenantScope = {
          kind: 'tenant',
          userId: null,
          organizationId: tenant.organizationId,
          role: 'job',
          storeIds: new Set([tenant.storeId]),
        };
        const first = await repo.markUninstalled(jobScope, tenant.storeId);
        expect(first?.status).toBe('uninstalled');

        const retry = await repo.markUninstalled(jobScope, tenant.storeId);
        expect(retry).toBeNull();
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it('denies upsertByShopDomain for an org outside scope before touching the shop domain', async () => {
      const tenantA = await seedTestTenant('store-repo-upsert-scope-a');
      const tenantB = await seedTestTenant('store-repo-upsert-scope-b');
      try {
        const repo = createStoreRepository(db);
        const scopeA = ownerScope(tenantA.organizationId, tenantA.storeId, tenantA.userId);
        await expect(
          repo.upsertByShopDomain(scopeA, {
            organizationId: tenantB.organizationId,
            shopDomain: `should-not-be-created-${Date.now()}.myshopify.com`,
          }),
        ).rejects.toThrow(TenantScopeViolationError);
      } finally {
        await cleanupTestTenant(tenantA);
        await cleanupTestTenant(tenantB);
      }
    });
  });

  describe('confirmIndiaOptIn (HLD §8 "Consent-region gate" layer 1, issue #72)', () => {
    it('sets the checklist timestamp on first confirmation', async () => {
      const tenant = await seedTestTenant('store-repo-optin-first');
      try {
        const repo = createStoreRepository(db);
        const scope = ownerScope(tenant.organizationId, tenant.storeId, tenant.userId);

        const result = await repo.confirmIndiaOptIn(scope, tenant.storeId);
        expect(result?.alreadyConfirmed).toBe(false);
        const at = (result?.store.privacyConfig as Record<string, unknown>)['checklist'] as Record<
          string,
          unknown
        >;
        expect(typeof at['india_opt_in_confirmed_at']).toBe('string');
        expect(new Date(at['india_opt_in_confirmed_at'] as string).toISOString()).toBe(
          at['india_opt_in_confirmed_at'],
        );
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it('is idempotent: a repeat keeps the original timestamp and reports alreadyConfirmed', async () => {
      const tenant = await seedTestTenant('store-repo-optin-repeat');
      try {
        const repo = createStoreRepository(db);
        const scope = ownerScope(tenant.organizationId, tenant.storeId, tenant.userId);

        const first = await repo.confirmIndiaOptIn(scope, tenant.storeId);
        const second = await repo.confirmIndiaOptIn(scope, tenant.storeId);
        expect(second?.alreadyConfirmed).toBe(true);
        const firstChecklist = (first?.store.privacyConfig as Record<string, unknown>)[
          'checklist'
        ] as Record<string, unknown>;
        const secondChecklist = (second?.store.privacyConfig as Record<string, unknown>)[
          'checklist'
        ] as Record<string, unknown>;
        expect(secondChecklist['india_opt_in_confirmed_at']).toBe(
          firstChecklist['india_opt_in_confirmed_at'],
        );
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it('merges into privacy_config without disturbing other keys (one home per setting)', async () => {
      const tenant = await seedTestTenant('store-repo-optin-merge');
      try {
        const repo = createStoreRepository(db);
        const scope = ownerScope(tenant.organizationId, tenant.storeId, tenant.userId);
        await db
          .update(stores)
          .set({ privacyConfig: { notice_version: 'v9' } })
          .where(eq(stores.id, tenant.storeId));

        const result = await repo.confirmIndiaOptIn(scope, tenant.storeId);
        expect(result?.store.privacyConfig).toMatchObject({
          notice_version: 'v9',
          checklist: { india_opt_in_confirmed_at: expect.any(String) },
        });
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it('denies confirmIndiaOptIn for a store outside scope (SPEC §5.10 test 7)', async () => {
      const tenantA = await seedTestTenant('store-repo-optin-scope-a');
      const tenantB = await seedTestTenant('store-repo-optin-scope-b');
      try {
        const repo = createStoreRepository(db);
        const scopeA = ownerScope(tenantA.organizationId, tenantA.storeId, tenantA.userId);
        await expect(repo.confirmIndiaOptIn(scopeA, tenantB.storeId)).rejects.toThrow(
          TenantScopeViolationError,
        );
      } finally {
        await cleanupTestTenant(tenantA);
        await cleanupTestTenant(tenantB);
      }
    });
  });
});
