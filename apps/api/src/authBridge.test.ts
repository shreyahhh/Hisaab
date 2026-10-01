import { and, eq } from 'drizzle-orm';
import { APIError } from 'better-auth/api';
import {
  AUTH_BASE_PATH,
  createAuth,
  DISABLED_AUTH_PATHS,
  EXPOSED_AUTH_ROUTES,
  noopEmailSender,
} from '@truepath/auth';
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

// issue #16: unlike the three original GET routes (always 200, no input), these validate their body/
// query and can't return 200 from an empty payload. `/request-password-reset` still can, with any
// syntactically valid email — Better Auth never reveals whether it matches a real account, so an
// unregistered address is exactly as good as a real one for proving the route (and the bridge's body
// fix) actually works, without seeding a user just for this generic sweep. `/reset-password` and
// `/reset-password/:token` are state-dependent (a real, unexpired token) and are proven properly, with
// a real body and a real audit row, in the dedicated tests further down this file instead.
const PAYLOAD_OVERRIDES: Record<string, unknown> = {
  '/request-password-reset': { email: 'auth-bridge-smoke-test@example.invalid' },
};
const NOT_PLAIN_200 = new Set(['/reset-password', '/reset-password/:token']);

const json = { origin: ORIGIN, 'content-type': 'application/json' };
function viaApp(e: Endpoint) {
  return app.inject({
    method: e.method as 'GET' | 'POST',
    url: `${AUTH_BASE_PATH}${e.example}`,
    // Without a trusted IP, Better Auth's rate limiter falls back to one shared bucket per path
    // (ADR-0019's `ipAddressHeaders: ['x-forwarded-for']` config trusts only this header, and inject's
    // own `remoteAddress` isn't it) — `/request-password-reset` in particular has its own strict
    // built-in special rule (3 per 60s), so every test hitting it needs its own IP or they'd all
    // collide into that single bucket.
    headers: { ...json, 'x-forwarded-for': '10.99.1.1' },
    remoteAddress: '10.99.1.1',
    ...(e.method === 'GET' ? {} : { payload: PAYLOAD_OVERRIDES[e.path] ?? {} }),
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
        // A reachable route is never a 404 (Fastify did register it) — exact success is only
        // asserted where a placeholder body/query can genuinely produce it (see NOT_PLAIN_200).
        if (NOT_PLAIN_200.has(e.path)) {
          expect(res.statusCode, 'an allow-listed route must respond').not.toBe(404);
        } else {
          expect(res.statusCode, 'an allow-listed route must respond').toBe(200);
        }
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
      // Fastify only mirrors a HEAD for a GET route, never for POST.
      ...EXPOSED_AUTH_ROUTES.flatMap((r) =>
        r.method === 'GET'
          ? [`GET ${AUTH_BASE_PATH}${r.path}`, `HEAD ${AUTH_BASE_PATH}${r.path}`]
          : [`${r.method} ${AUTH_BASE_PATH}${r.path}`],
      ),
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
      const payload = PAYLOAD_OVERRIDES[route.path];
      const res = await testAuth.handler(
        new Request(`http://localhost:3000${AUTH_BASE_PATH}${route.path}`, {
          method: route.method,
          headers: { ...json, 'x-forwarded-for': '10.98.1.2' },
          ...(route.method === 'POST' ? { body: JSON.stringify(payload ?? {}) } : {}),
        }),
      );
      if (NOT_PLAIN_200.has(route.path)) {
        expect(res.status, route.path).not.toBe(404);
      } else {
        expect(res.status, route.path).toBe(200);
      }
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

// issue #16: request-password-reset and reset-password, bridged straight to Better Auth (no wrapper
// route of our own), audited via the sendResetPassword/onPasswordReset hooks in
// packages/auth/src/betterAuth.ts. These also double as the "a bridged POST body arrives" proof the
// issue asks for — none of this passes unless authBridge.ts's body fix actually works, since Better
// Auth's own zod validation on both endpoints requires the JSON body it reads.
//
// A verification token is ephemeral (secondaryStorage: Redis, betterAuth.ts), not a Postgres row, so
// the only way to get the real token a test needs is the same way a shopper would: from the URL
// sendResetPassword hands to the email sender. This file's shared `testAuth` always uses
// `noopEmailSender` (discards the URL), so these tests build one extra Better Auth instance —
// identical config, a capturing email sender — purely to observe that URL.
describe('password reset (issue #16)', () => {
  function buildResetTestApp() {
    const sentUrls: string[] = [];
    const auth = createAuth({
      db: testDb,
      env: {
        BETTER_AUTH_SECRET: 'a'.repeat(32),
        BETTER_AUTH_URL: 'http://localhost:3000',
        DASHBOARD_URL: 'http://localhost:5173',
        GOOGLE_CLIENT_ID: 'test-google-client-id',
        GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      },
      redisDurableUrl: 'redis://localhost:6379',
      allowInsecureCookies: true,
      emailSender: {
        ...noopEmailSender,
        async sendPasswordReset({ url }) {
          sentUrls.push(url);
        },
      },
    });
    return { app: buildTestApp({ auth }), auth, sentUrls };
  }

  function tokenFromUrl(url: string): string {
    const match = /\/reset-password\/([^/?]+)/.exec(url);
    if (!match) throw new Error(`tokenFromUrl: no token in ${url}`);
    return match[1]!;
  }

  async function passwordResetAuditRows(
    action: 'password_reset_requested' | 'password_reset_completed',
  ) {
    return testDb
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.action, action), eq(schema.auditLog.targetId, 'password_reset')),
      );
  }

  it('requesting a reset for a real user audits password_reset_requested with target_user_id only, and creates a token', async () => {
    const reset = buildResetTestApp();
    const owner = await seedRealTenant(reset.auth, testDb, 'reset-request-ok');
    try {
      const before = (await passwordResetAuditRows('password_reset_requested')).length;
      const res = await reset.app.inject({
        method: 'POST',
        url: `${AUTH_BASE_PATH}/request-password-reset`,
        headers: { ...json, 'x-forwarded-for': '10.96.1.1' },
        remoteAddress: '10.96.1.1',
        payload: { email: owner.email },
      });
      expect(res.statusCode).toBe(200);

      const rows = await passwordResetAuditRows('password_reset_requested');
      expect(rows.length).toBe(before + 1);
      const latest = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
      expect(latest).toMatchObject({
        organizationId: null,
        actorUserId: null,
        actorType: 'user',
        metadata: { target_user_id: owner.userId },
      });
      expect(JSON.stringify(latest.metadata)).not.toContain(owner.email);

      expect(reset.sentUrls).toHaveLength(1);
      tokenFromUrl(reset.sentUrls[0]!); // throws if the URL doesn't carry one
    } finally {
      await reset.app.close();
      await cleanupRealTenant(testDb, owner);
    }
  });

  it('requesting a reset for an unknown email is still 200, and audits nothing', async () => {
    const reset = buildResetTestApp();
    try {
      const before = (await passwordResetAuditRows('password_reset_requested')).length;
      const res = await reset.app.inject({
        method: 'POST',
        url: `${AUTH_BASE_PATH}/request-password-reset`,
        headers: { ...json, 'x-forwarded-for': '10.96.1.4' },
        remoteAddress: '10.96.1.4',
        payload: { email: 'reset-request-unknown@example.invalid' },
      });
      expect(res.statusCode).toBe(200);
      expect((await passwordResetAuditRows('password_reset_requested')).length).toBe(before);
      expect(reset.sentUrls).toHaveLength(0); // no email is sent for an unknown address either
    } finally {
      await reset.app.close();
    }
  });

  it('completing a reset with the real token changes the password and audits password_reset_completed', async () => {
    const reset = buildResetTestApp();
    const owner = await seedRealTenant(reset.auth, testDb, 'reset-complete-ok');
    try {
      await reset.app.inject({
        method: 'POST',
        url: `${AUTH_BASE_PATH}/request-password-reset`,
        headers: { ...json, 'x-forwarded-for': '10.96.1.2' },
        remoteAddress: '10.96.1.2',
        payload: { email: owner.email },
      });
      const token = tokenFromUrl(reset.sentUrls[0]!);
      const before = (await passwordResetAuditRows('password_reset_completed')).length;

      const newPassword = 'a-different-long-password-456';
      const res = await reset.app.inject({
        method: 'POST',
        url: `${AUTH_BASE_PATH}/reset-password`,
        headers: { ...json, 'x-forwarded-for': '10.96.1.2' },
        remoteAddress: '10.96.1.2',
        payload: { token, newPassword },
      });
      expect(res.statusCode).toBe(200);

      const rows = await passwordResetAuditRows('password_reset_completed');
      expect(rows.length).toBe(before + 1);
      const latest = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
      expect(latest).toMatchObject({
        organizationId: null,
        actorUserId: owner.userId,
        actorType: 'user',
        metadata: { target_user_id: owner.userId },
      });

      const signIn = await reset.auth.api.signInEmail({
        body: { email: owner.email, password: newPassword },
      });
      expect(signIn.user.id).toBe(owner.userId);
    } finally {
      await reset.app.close();
      await cleanupRealTenant(testDb, owner);
    }
  });

  it('an invalid token is rejected and audits nothing (failure path)', async () => {
    const reset = buildResetTestApp();
    try {
      const before = (await passwordResetAuditRows('password_reset_completed')).length;
      const res = await reset.app.inject({
        method: 'POST',
        url: `${AUTH_BASE_PATH}/reset-password`,
        headers: { ...json, 'x-forwarded-for': '10.96.1.3' },
        remoteAddress: '10.96.1.3',
        payload: { token: 'not-a-real-token', newPassword: 'a-different-long-password-456' },
      });
      expect(res.statusCode).toBe(400);
      expect((await passwordResetAuditRows('password_reset_completed')).length).toBe(before);
    } finally {
      await reset.app.close();
    }
  });
});
