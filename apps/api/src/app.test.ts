import { describe, expect, it } from 'vitest';
import { buildTestApp, testAuth, testDb } from './testApp.js';
import { cleanupRealTenant, seedRealTenant } from './testAuthTenant.js';

describe('buildApp', () => {
  it('responds to /healthz', async () => {
    const app = buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    } finally {
      await app.close();
    }
  });

  it('bridges /v1/auth/* to the real Better Auth handler', async () => {
    const app = buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/auth/get-session' });
      expect(res.statusCode).toBe(200);
      // No session cookie sent — Better Auth's own response for "not signed in".
      expect(res.body === 'null' || res.body === '').toBe(true);
    } finally {
      await app.close();
    }
  });

  it('populates routeRegistry from every registered route (drives the cross-tenant harness)', async () => {
    const app = buildTestApp();
    try {
      await app.ready();
      expect(app.routeRegistry.some((r) => r.url === '/healthz' && r.method === 'GET')).toBe(true);
      expect(
        app.routeRegistry.some((r) => r.url === '/v1/auth/get-session' && r.method === 'GET'),
      ).toBe(true);
      expect(
        app.routeRegistry.some((r) => r.url.includes('*') && r.url.startsWith('/v1/auth')),
      ).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('buildApp — CSRF check on our own state-changing routes (auth-tenancy.md §4.1)', () => {
  it('rejects a POST with no Origin header', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'csrf-no-origin');
    const app = buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/orgs/${owner.organizationId}/invites`,
        headers: { cookie: owner.cookie, 'content-type': 'application/json' },
        payload: { email: 'someone@example.invalid', role: 'viewer' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'invalid_origin' });
    } finally {
      await app.close();
      await cleanupRealTenant(testDb, owner);
    }
  });

  it('rejects a POST from an untrusted Origin', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'csrf-bad-origin');
    const app = buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/orgs/${owner.organizationId}/invites`,
        headers: {
          cookie: owner.cookie,
          origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        payload: { email: 'someone@example.invalid', role: 'viewer' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'invalid_origin' });
    } finally {
      await app.close();
      await cleanupRealTenant(testDb, owner);
    }
  });

  it('rejects a POST whose Content-Type is not application/json', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'csrf-bad-content-type');
    const app = buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/orgs/${owner.organizationId}/invites`,
        headers: {
          cookie: owner.cookie,
          origin: 'http://localhost:5173',
          'content-type': 'text/plain',
        },
        payload: 'email=someone@example.invalid&role=viewer',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'invalid_content_type' });
    } finally {
      await app.close();
      await cleanupRealTenant(testDb, owner);
    }
  });

  it('accepts a POST with the trusted Origin and application/json', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'csrf-ok');
    const app = buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/orgs/${owner.organizationId}/invites`,
        headers: { cookie: owner.cookie, origin: 'http://localhost:5173' },
        payload: { email: 'someone@example.invalid', role: 'viewer' },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
      await cleanupRealTenant(testDb, owner);
    }
  });

  it('never applies the CSRF check to GET requests', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'csrf-get-exempt');
    const app = buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${owner.organizationId}/stores`,
        headers: { cookie: owner.cookie }, // no origin, no content-type
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
      await cleanupRealTenant(testDb, owner);
    }
  });
});
