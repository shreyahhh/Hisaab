import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { requireStoreScope } from './tenantScope.js';
import { testAuth, testDb } from './testApp.js';
import { addRealMember, cleanupRealTenant, seedRealTenant } from './testAuthTenant.js';

// requireStoreScope has no production caller yet (M0-4's confirmed route set is all :id-as-org —
// SPEC §10), but its identical-404 guarantee (auth-tenancy.md §4.3 step 2b) is exercised here
// directly against a minimal throwaway route, ready for the first real :storeId route to reuse.
function buildProbeApp() {
  const app = Fastify({ logger: false });
  app.get<{ Params: { storeId: string } }>(
    '/test/stores/:storeId',
    { preHandler: [requireStoreScope({ auth: testAuth, db: testDb })] },
    async (request, reply) => {
      const scope = request.scope!;
      // Sets don't survive JSON.stringify (they serialize to `{}`) — spell it out as an array.
      await reply.send({ scope: { ...scope, storeIds: [...scope.storeIds] } });
    },
  );
  return app;
}

describe('requireStoreScope — identical 404 (auth-tenancy.md §4.3 step 2b, SPEC §5.10 test 7)', () => {
  it('returns byte-for-byte the same 404 for a non-existent store and a foreign store', async () => {
    const caller = await seedRealTenant(testAuth, testDb, 'store-scope-caller');
    const foreignOwner = await seedRealTenant(testAuth, testDb, 'store-scope-foreign');
    const app = buildProbeApp();
    try {
      const nonExistentRes = await app.inject({
        method: 'GET',
        url: '/test/stores/00000000-0000-0000-0000-000000000000',
        headers: { cookie: caller.cookie },
      });
      const foreignRes = await app.inject({
        method: 'GET',
        url: `/test/stores/${foreignOwner.storeId}`,
        headers: { cookie: caller.cookie },
      });

      expect(nonExistentRes.statusCode).toBe(404);
      expect(foreignRes.statusCode).toBe(404);
      expect(nonExistentRes.statusCode).toBe(foreignRes.statusCode);
      expect(nonExistentRes.body).toBe(foreignRes.body);
      expect(JSON.parse(nonExistentRes.body)).toEqual({ error: 'not_found' });
    } finally {
      await app.close();
      await cleanupRealTenant(testDb, caller);
      await cleanupRealTenant(testDb, foreignOwner);
    }
  });

  it('builds a scope (200) for a store the caller actually belongs to', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'store-scope-own');
    const app = buildProbeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/test/stores/${owner.storeId}`,
        headers: { cookie: owner.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().scope.organizationId).toBe(owner.organizationId);
      expect(res.json().scope.storeIds).toEqual([owner.storeId]);
    } finally {
      await app.close();
      await cleanupRealTenant(testDb, owner);
    }
  });

  it("a member of the store's own organization is not treated as foreign", async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'store-scope-member-owner');
    const viewer = await addRealMember(
      testAuth,
      testDb,
      owner,
      'store-scope-member-viewer',
      'viewer',
    );
    const app = buildProbeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/test/stores/${owner.storeId}`,
        headers: { cookie: viewer.cookie },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
      await cleanupRealTenant(testDb, owner);
    }
  });
});
