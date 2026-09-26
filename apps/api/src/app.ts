import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import type { Auth } from '@truepath/auth';
import type { Db } from '@truepath/db';
import { bridgeToBetterAuth } from './authBridge.js';
import { registerRouteRegistry } from './routeRegistry.js';
import { registerAuthWrapperRoutes } from './routes/authWrappers.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerMemberRoutes } from './routes/members.js';
import { registerMeRoutes } from './routes/me.js';
import { registerOrgRoutes } from './routes/orgs.js';

export interface AppDeps {
  readonly db: Db;
  readonly auth: Auth;
  /** Dashboard origin allowed to call this API with credentials (auth-tenancy.md §4.1 CSRF check). */
  readonly trustedOrigin: string;
}

// Core API (SPEC §10, §4): auth, tenants, integrations, reports, DPDP endpoints, webhooks. Built as
// a plain function (not started here) so tests can exercise it via `.inject()` without binding a
// port.
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  registerRouteRegistry(app);

  void app.register(fastifyCors, { origin: deps.trustedOrigin, credentials: true });

  // CSRF check for our own state-changing routes (auth-tenancy.md §4.1): the generic /v1/auth/*
  // bridge below is exempt because Better Auth enforces its own origin check on those routes
  // (betterAuth.ts's disableOriginCheck: false). @fastify/cors already blocks a *browser* reading
  // a cross-origin response, but a non-preflighted "simple" cross-site form POST still reaches the
  // handler and executes before CORS ever comes into it — this hook is what actually stops that.
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/v1/auth/')) return;
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS')
      return;

    // Only methods that actually carry a JSON body need a Content-Type check — a bodyless DELETE
    // has none to police, and (unlike POST) a browser can't send it via a non-preflighted "simple"
    // request at all, so DELETE already gets its CSRF protection from the browser's own mandatory
    // preflight; the Origin check below is this hook's defense-in-depth for it regardless.
    if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
      const contentType = request.headers['content-type'];
      if (!contentType?.split(';')[0]?.trim().toLowerCase().includes('application/json')) {
        await reply.code(403).send({ error: 'invalid_content_type' });
        return;
      }
    }
    if (request.headers.origin !== deps.trustedOrigin) {
      await reply.code(403).send({ error: 'invalid_origin' });
    }
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  // Better Auth's own routes (sign-in/social, callback/google, verify-email, reset-password, ...)
  // — auth-tenancy.md §2.1. Mounted as a catch-all; only the routes of enabled features respond.
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/auth/*',
    handler: (request, reply) => bridgeToBetterAuth(deps.auth, request, reply),
  });

  registerAuthWrapperRoutes(app, deps);
  registerMeRoutes(app, deps);
  registerOrgRoutes(app, deps);
  registerInviteRoutes(app, deps);
  registerMemberRoutes(app, deps);

  app.decorate('appDeps', deps);

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    appDeps: AppDeps;
  }
}
