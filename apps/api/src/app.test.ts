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

// We have no non-browser clients, so the rule is flat: every state-changing request (anything but
// GET, HEAD and OPTIONS) must carry exactly the dashboard's Origin, or it is a 403 — a missing
// Origin included. JSON is sent throughout so that it is the Origin being judged, not the content type.
describe('buildApp — every state-changing request needs the dashboard Origin (403 otherwise)', () => {
  const TRUSTED = 'http://localhost:5173';
  const ID = '3f0c9a1e-77aa-4d1b-9c0e-0a1b2c3d4e5f';
  const requests = [
    ['POST', '/v1/auth/login'],
    ['POST', '/v1/auth/signup'],
    ['POST', '/v1/auth/logout'],
    ['POST', '/v1/orgs'],
    ['POST', `/v1/orgs/${ID}/invites`],
    ['POST', `/v1/invites/${ID}/accept`],
    ['PUT', `/v1/orgs/${ID}/members/${ID}`],
    ['DELETE', `/v1/orgs/${ID}/members/${ID}`],
    ['PATCH', `/v1/orgs/${ID}`],
    ['PUT', '/v1/no-such-route'],
    ['DELETE', '/v1/no-such-route'],
    ['POST', '/v1/auth/organization/delete'],
  ] as const;
  const badOrigins: Array<[string, string | undefined]> = [
    ['no Origin header', undefined],
    ['Origin: null', 'null'],
    ['an empty Origin', ''],
    ['another origin', 'http://evil.example'],
    ['the dashboard origin with a trailing slash', `${TRUSTED}/`],
    ['the dashboard origin over https', 'https://localhost:5173'],
    ['a look-alike host', 'http://localhost:5173.evil.example'],
  ];

  const send = (
    app: ReturnType<typeof buildTestApp>,
    method: string,
    url: string,
    origin?: string,
  ) =>
    app.inject({
      method: method as 'POST',
      url,
      headers: { 'content-type': 'application/json', ...(origin === undefined ? {} : { origin }) },
      // issue #11: distinct from authBridge.test.ts's own fixed IP — this worker's rate-limit
      // counters are shared across every file it runs, so two files reusing the same literal IP
      // can push each other toward the per-IP limit.
      remoteAddress: '10.96.201.1',
      ...(method === 'DELETE' ? {} : { payload: {} }),
    });

  it.each(
    requests.flatMap(([method, url]) =>
      badOrigins.map(([label, origin]) => [method, url, label, origin] as const),
    ),
  )('%s %s with %s is a 403 invalid_origin', async (method, url, _label, origin) => {
    const app = buildTestApp();
    try {
      const res = await send(app, method, url, origin);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'invalid_origin' });
    } finally {
      await app.close();
    }
  });

  it.each(requests)(
    '%s %s with the dashboard Origin is not stopped by the hook',
    async (method, url) => {
      const app = buildTestApp();
      try {
        const res = await send(app, method, url, TRUSTED);
        expect(res.statusCode).not.toBe(403);
      } finally {
        await app.close();
      }
    },
  );

  it('with no Origin and no JSON content type it is still a 403 (the content type is judged first)', async () => {
    const app = buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orgs',
        payload: 'x',
        headers: { 'content-type': 'text/plain' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'invalid_content_type' });
    } finally {
      await app.close();
    }
  });

  it.each(['GET', 'HEAD'] as const)('%s is never judged by the hook', async (method) => {
    const app = buildTestApp();
    try {
      const res = await app.inject({ method, url: '/healthz' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
