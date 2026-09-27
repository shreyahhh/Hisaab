import { repositoryRegistry } from '@truepath/db';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '@truepath/db/testing';
import { TenantScopeViolationError, type TenantScope } from '@truepath/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverCrossTenantRoutes,
  findStaleExemptions,
  findUncoveredRoutes,
} from './crossTenant.js';
import { buildTestApp, testAuth, testDb } from './testApp.js';
import { cleanupRealTenant, seedRealTenant } from './testAuthTenant.js';

// The generated cross-tenant harness (SPEC §5.10 test 7; auth-tenancy.md §8): for every registered
// Fastify route and every @truepath/db repository method, seeds two tenants and asserts tenant B's
// ids are denied under tenant A's scope. Discovery is automatic (routeRegistry, repositoryRegistry)
// — nothing here is a hand-maintained list, so a route or repository method added by a later
// ticket without updating this file is still covered.

let tenantsToCleanup: TestTenant[] = [];

afterEach(async () => {
  for (const tenant of tenantsToCleanup) {
    await cleanupTestTenant(tenant);
  }
  tenantsToCleanup = [];
});

async function seedTwoTenants(): Promise<{ tenantA: TestTenant; tenantB: TestTenant }> {
  const tenantA = await seedTestTenant('harness-a');
  const tenantB = await seedTestTenant('harness-b');
  tenantsToCleanup.push(tenantA, tenantB);
  return { tenantA, tenantB };
}

describe('SPEC §5.10 test 7 — repository methods (via @truepath/db repositoryRegistry)', () => {
  for (const repo of repositoryRegistry) {
    for (const method of repo.methods) {
      it(`${repo.name}.${method.name} denies a scope that does not cover the requested ${method.scopeKind}`, async () => {
        const { tenantA, tenantB } = await seedTwoTenants();
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
      });
    }
  }
});

describe('SPEC §5.10 test 7 — Fastify routes (via routeRegistry)', () => {
  it("discovers every tenant-scoped route and denies tenant B's ids under tenant A's real session", async () => {
    const tenantA = await seedRealTenant(testAuth, testDb, 'route-harness-a');
    const tenantB = await seedRealTenant(testAuth, testDb, 'route-harness-b');
    const app = buildTestApp();
    try {
      await app.ready();
      const discovered = discoverCrossTenantRoutes(app.routeRegistry, {
        id: tenantB.organizationId,
        orgId: tenantB.organizationId,
        storeId: tenantB.storeId,
        userId: tenantB.userId,
      });

      // Grows automatically as routes are registered — no edits needed here. As of this ticket
      // that's GET /v1/orgs/:id/stores, GET /v1/orgs/:id/audit-log, POST /v1/orgs/:id/invites,
      // PUT/DELETE /v1/orgs/:id/members/:userId, and (M1-1, ADR-0024) GET
      // /v1/orgs/:id/integrations/shopify/connect and DELETE /v1/orgs/:id/integrations/:integrationId
      // — both discovered purely from their `:id` param, with no per-route override.
      expect(discovered.length).toBeGreaterThan(0);
      const discoveredKeys = discovered.map((r) => `${r.method} ${r.url}`);
      expect(discoveredKeys).toContain('GET /v1/orgs/:id/integrations/shopify/connect');
      expect(discoveredKeys).toContain('DELETE /v1/orgs/:id/integrations/:integrationId');
      for (const route of discovered) {
        const needsBody = route.method === 'POST' || route.method === 'PUT';
        const res = await app.inject({
          method: route.method,
          url: route.foreignUrl,
          headers: {
            cookie: tenantA.cookie,
            origin: 'http://localhost:5173', // matches testApp.ts's buildTestApp trustedOrigin
            ...(needsBody ? { 'content-type': 'application/json' } : {}),
          },
          payload: needsBody ? {} : undefined,
        });
        expect(res.statusCode, `${route.method} ${route.url} must 404 for a foreign id`).toBe(404);
      }
    } finally {
      await app.close();
      await cleanupRealTenant(testDb, tenantA);
      await cleanupRealTenant(testDb, tenantB);
    }
  });

  it('has no coverage gap: every registered route is tenant-scope-tested or explicitly exempt', async () => {
    const app = buildTestApp();
    try {
      await app.ready();
      const uncovered = findUncoveredRoutes(app.routeRegistry);
      expect(
        uncovered,
        `These routes are neither discovered as tenant-scoped nor listed in EXEMPT_ROUTES with a reason — add a reason to EXEMPT_ROUTES in crossTenant.ts, or fix the route's param naming: ${JSON.stringify(uncovered)}`,
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('has no stale exemption: every EXEMPT_ROUTES entry still matches a real registered route', async () => {
    const app = buildTestApp();
    try {
      await app.ready();
      const stale = findStaleExemptions(app.routeRegistry);
      expect(
        stale,
        `These EXEMPT_ROUTES entries no longer match any registered route — the route was renamed or removed; delete or update the entry: ${JSON.stringify(stale)}`,
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
