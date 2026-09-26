import { eq } from 'drizzle-orm';
import { APIError } from 'better-auth/api';
import { AUTH_BASE_PATH, DISABLED_AUTH_PATHS, EXPOSED_AUTH_ROUTES } from '@truepath/auth';
import { schema } from '@truepath/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, testAuth, testDb } from './testApp.js';
import { cleanupRealTenant, seedRealTenant } from './testAuthTenant.js';

// Better Auth ships ~50 HTTP endpoints; almost every one does something audit-worthy that only our own
// routes audit (ADR-0022). This enumerates EVERY endpoint Better Auth's router has with our config and
// plugins, and asserts that only the allow-listed ones are reachable through the app. A Better Auth
// upgrade or a new plugin that adds an endpoint fails here until someone decides about it.

const ORIGIN = 'http://localhost:5173';
const app = buildTestApp();

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

interface Endpoint {
  readonly method: string;
  /** Relative to the auth base path, parameters as declared (`/callback/:id`). */
  readonly path: string;
  /** A concrete request path for it (`/callback/google`). */
  readonly example: string;
}

// `auth.api` also holds server-only functions with no HTTP path (addMember, setPassword): they can't be
// reached over HTTP at all, so they aren't rows here.
const endpoints: Endpoint[] = Object.values(testAuth.api as Record<string, unknown>)
  .filter(
    (ep): ep is { path: string; options?: { method?: string | string[] } } =>
      typeof (ep as { path?: unknown } | null)?.path === 'string',
  )
  .flatMap((ep) =>
    ([] as string[]).concat(ep.options?.method ?? 'GET').map((method) => ({
      method,
      path: ep.path,
      example: ep.path.replace(':id', 'google').replace(/:\w+/g, 'x'),
    })),
  )
  .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

const exposed = (method: string, path: string) =>
  EXPOSED_AUTH_ROUTES.some((route) => route.method === method && route.path === path);

// Paths `disabledPaths` can't list because they carry a parameter, so only the allow-list covers them.
const ALLOW_LIST_ONLY = ['/reset-password/:token'];

const json = { origin: ORIGIN, 'content-type': 'application/json' };
function viaApp(e: Endpoint) {
  return app.inject({
    method: e.method as 'GET' | 'POST',
    url: `${AUTH_BASE_PATH}${e.example}`,
    headers: json,
    remoteAddress: '10.99.1.1',
    ...(e.method === 'GET' ? {} : { payload: {} }),
  });
}

describe('the enumeration covers Better Auth completely', () => {
  it('finds the endpoints (a guard against this test passing vacuously)', () => {
    const paths = new Set(endpoints.map((e) => e.path));
    expect(paths.size).toBeGreaterThanOrEqual(50);
    for (const path of [
      '/get-session',
      '/sign-in/email',
      '/organization/delete',
      '/callback/:id',
    ]) {
      expect(paths, path).toContain(path);
    }
  });
});

describe('through the app, only the allow-listed Better Auth routes are reachable', () => {
  it.each(endpoints.map((e) => [`${e.method} ${AUTH_BASE_PATH}${e.path}`, e] as const))(
    '%s',
    async (_label, e) => {
      const res = await viaApp(e);
      if (exposed(e.method, e.path)) {
        expect(res.statusCode, 'an allow-listed route must respond').toBe(200);
      } else {
        // Fastify's own answer: the route isn't registered, so Better Auth never sees the request.
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: 'not_found' });
      }
    },
  );

  it('registers only the allow-list, our three wrappers and their HEAD mirrors under /v1/auth: no wildcard', () => {
    const registered = app.routeRegistry
      .filter((r) => r.url.startsWith(`${AUTH_BASE_PATH}`))
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    const expected = [
      ...EXPOSED_AUTH_ROUTES.flatMap((r) => [
        `GET ${AUTH_BASE_PATH}${r.path}`,
        `HEAD ${AUTH_BASE_PATH}${r.path}`,
      ]),
      `POST ${AUTH_BASE_PATH}/signup`,
      `POST ${AUTH_BASE_PATH}/login`,
      `POST ${AUTH_BASE_PATH}/logout`,
    ].sort();
    expect(registered).toEqual(expected);
    expect(registered.some((r) => r.includes('*'))).toBe(false);
  });

  it('answers an unknown path with a bare 404 that does not echo the route', async () => {
    const res = await app.inject({ method: 'GET', url: `${AUTH_BASE_PATH}/nope`, headers: json });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });
});

describe('every Better Auth path is either exposed or disabled (an upgrade cannot add one silently)', () => {
  const paths = [...new Set(endpoints.map((e) => e.path))];

  it.each(paths.map((p) => [p] as const))('%s', (path) => {
    const example = endpoints.find((e) => e.path === path)!.example;
    if (EXPOSED_AUTH_ROUTES.some((r) => r.path === path)) return;
    const disabled =
      (DISABLED_AUTH_PATHS as readonly string[]).includes(path) ||
      (DISABLED_AUTH_PATHS as readonly string[]).includes(example);
    expect(
      disabled || ALLOW_LIST_ONLY.includes(path),
      `${path} is neither in EXPOSED_AUTH_ROUTES nor DISABLED_AUTH_PATHS (packages/auth/src/exposure.ts). Decide: disable it, or expose it in the same change that audits it.`,
    ).toBe(true);
  });

  it('has no stale entry in either list, and no overlap between them', () => {
    const real = new Set(paths);
    const realOrExample = new Set([...paths, ...endpoints.map((e) => e.example)]);
    for (const route of EXPOSED_AUTH_ROUTES) {
      expect(real, `exposed ${route.path} is not a Better Auth path`).toContain(route.path);
      expect(endpoints.some((e) => e.path === route.path && e.method === route.method)).toBe(true);
    }
    for (const path of DISABLED_AUTH_PATHS) {
      expect(realOrExample, `disabled ${path} is not a Better Auth path`).toContain(path);
      expect(
        EXPOSED_AUTH_ROUTES.map((r) => r.path),
        `${path} is both`,
      ).not.toContain(path);
    }
    for (const path of ALLOW_LIST_ONLY) expect(real, `${path} is gone`).toContain(path);
    expect(new Set(DISABLED_AUTH_PATHS).size).toBe(DISABLED_AUTH_PATHS.length);
  });
});

// Behind the bridge, Better Auth refuses the same paths itself.
describe("Better Auth's own router refuses every disabled path, bypassing the bridge", () => {
  const byPath = new Map(endpoints.map((e) => [e.example, e]));

  it.each(DISABLED_AUTH_PATHS.map((p) => [p] as const))('%s', async (path) => {
    const e = byPath.get(path);
    expect(e, `${path} is not an endpoint`).toBeDefined();
    const res = await testAuth.handler(
      new Request(`http://localhost:3000${AUTH_BASE_PATH}${path}`, {
        method: e!.method,
        headers: { ...json, 'x-forwarded-for': '10.98.1.1' },
        ...(e!.method === 'GET' ? {} : { body: '{}' }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('still serves the allow-listed routes', async () => {
    for (const route of EXPOSED_AUTH_ROUTES) {
      const res = await testAuth.handler(
        new Request(`http://localhost:3000${AUTH_BASE_PATH}${route.path}`, {
          method: route.method,
          headers: { ...json, 'x-forwarded-for': '10.98.1.2' },
        }),
      );
      expect(res.status, route.path).toBe(200);
    }
  });
});

describe('our own routes are unaffected by the disabled paths (they call auth.api directly)', () => {
  it('server-side calls to a disabled path still run', async () => {
    const error = await testAuth.api
      .signInEmail({
        body: { email: 'nobody@example.invalid', password: 'wrong-password-long-enough' },
      })
      .catch((e: unknown) => e);
    // Better Auth answered (a credentials error), not "Not Found" from a disabled path.
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).body?.code).toBe('INVALID_EMAIL_OR_PASSWORD');
  });
});

describe('organization deletion is disabled in Better Auth itself (issue #8 owns the audited flow)', () => {
  it('refuses even a server-side deleteOrganization by the owner, and the organization survives', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'bridge-org-delete');
    try {
      const error = await testAuth.api
        .deleteOrganization({
          body: { organizationId: owner.organizationId },
          headers: new Headers({ cookie: owner.cookie }),
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(APIError);
      expect((error as APIError).body?.code).toBe('ORGANIZATION_DELETION_DISABLED');
      const rows = await testDb
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, owner.organizationId));
      expect(rows).toHaveLength(1);
    } finally {
      await cleanupRealTenant(testDb, owner);
    }
  });
});

// Our /v1/auth/signup|login|logout wrappers call auth.api directly, which skips Better Auth's origin
// check, so the app's own CSRF hook is their only one.
describe('the CSRF hook covers our /v1/auth wrappers', () => {
  const evil = { origin: 'http://evil.example', 'content-type': 'application/json' };

  it.each(['signup', 'login', 'logout'])(
    'POST /v1/auth/%s from another origin is a 403',
    async (name) => {
      const res = await app.inject({
        method: 'POST',
        url: `${AUTH_BASE_PATH}/${name}`,
        headers: evil,
        remoteAddress: '10.97.1.1',
        payload: {
          email: 'nobody@example.invalid',
          password: 'wrong-password-long-enough',
          name: 'x',
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'invalid_origin' });
    },
  );

  it.each(['signup', 'login', 'logout'])(
    'POST /v1/auth/%s without a JSON content type is a 403',
    async (name) => {
      const res = await app.inject({
        method: 'POST',
        url: `${AUTH_BASE_PATH}/${name}`,
        headers: { origin: ORIGIN, 'content-type': 'text/plain' },
        remoteAddress: '10.97.1.2',
        payload: 'x',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'invalid_content_type' });
    },
  );
});
