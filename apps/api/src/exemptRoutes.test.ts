import { afterAll, describe, expect, it } from 'vitest';
import { buildTestApp, testAuth, testDb } from './testApp.js';
import { cleanupRealTenant, seedRealTenant } from './testAuthTenant.js';

// EXEMPT_ROUTES (crossTenant.ts) skips GET /v1/orgs and GET /v1/me in the generated cross-tenant
// harness because they take no id to substitute. That is only sound if they return the *caller's*
// data and nothing else — which is what these prove, with two real tenants side by side.

const app = buildTestApp();

afterAll(async () => {
  await app.close();
});

describe("GET /v1/orgs and GET /v1/me return only the caller's own data", () => {
  it('user A never sees org B (or user B) — and vice versa', async () => {
    const a = await seedRealTenant(testAuth, testDb, 'exempt-a');
    const b = await seedRealTenant(testAuth, testDb, 'exempt-b');
    try {
      const orgsA = await app.inject({
        method: 'GET',
        url: '/v1/orgs',
        headers: { cookie: a.cookie },
      });
      expect(orgsA.statusCode).toBe(200);
      const idsA = (orgsA.json().organizations as Array<{ id: string }>).map((o) => o.id);
      expect(idsA).toEqual([a.organizationId]);
      // Nothing of B leaks anywhere in the body — not just the ids list.
      for (const foreign of [b.organizationId, b.userId, b.email, b.storeId]) {
        expect(orgsA.body).not.toContain(foreign);
      }

      const meA = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: a.cookie } });
      expect(meA.statusCode).toBe(200);
      expect(meA.json().user.id).toBe(a.userId);
      expect(meA.json().memberships).toEqual([{ organizationId: a.organizationId, role: 'owner' }]);
      for (const foreign of [b.organizationId, b.userId, b.email]) {
        expect(meA.body).not.toContain(foreign);
      }

      // And the other direction, so a bug that only ever favoured "the first tenant" can't pass.
      const meB = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: b.cookie } });
      expect(meB.json().user.id).toBe(b.userId);
      expect(meB.body).not.toContain(a.organizationId);
      expect(meB.body).not.toContain(a.email);
    } finally {
      await cleanupRealTenant(testDb, a);
      await cleanupRealTenant(testDb, b);
    }
  });

  it('both are 401 without a session — no anonymous view of anyone', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/orgs' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
  });
});
