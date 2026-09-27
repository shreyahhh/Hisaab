import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import type { Auth } from '@truepath/auth';
import { createAuditLogRepository, type Db } from '@truepath/db';
import { createAuditService, type AuditService } from './audit.js';
import { registerAuthBridge } from './authBridge.js';
import { registerAuthErrorHandler, type ErrorReporter } from './errors.js';
import {
  createEmailLimiter,
  ipLimit,
  LIMITS,
  registerRateLimit,
  type RateLimitDeps,
  type RouteLimits,
} from './rateLimit.js';
import { registerRouteRegistry } from './routeRegistry.js';
import type { TenantScopeDeps } from './tenantScope.js';
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
  /** Audit writer; defaults to one on `db`. Tests inject one whose writes fail. */
  readonly audit?: AuditService;
  /** Durable-Redis limiter for our own routes (signup, login, invite-accept) — see rateLimit.ts. */
  readonly rateLimit: RateLimitDeps;
  /**
   * Fastify `trustProxy`: which proxies (e.g. the ALB's VPC CIDR) to trust for `request.ip`. Left
   * unset, every client behind the ALB shares the ALB's IP, so the per-IP limits fail closed for all
   * of them; `true` would trust a spoofable X-Forwarded-For from anyone.
   */
  readonly trustProxy?: boolean | string | string[];
  /** Overrides how an unhandled error is logged (errors.ts); defaults to one stderr JSON line. */
  readonly errorReporter?: ErrorReporter;
}

// Core API (SPEC §10, §4): auth, tenants, integrations, reports, DPDP endpoints, webhooks. Built as
// a plain function (not started here) so tests can exercise it via `.inject()` without binding a
// port.
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: deps.trustProxy ?? false,
    // A UUID, not Fastify's default per-process counter ("req-1", "req-2", ...): this id is
    // returned to the client on an unhandled error (errors.ts) as the key to find its server-side
    // log line, so it must stay unique across restarts and across the several API instances a real
    // deployment runs, not just within one process.
    genReqId: () => randomUUID(),
  });

  registerRouteRegistry(app);
  const tenantDeps: TenantScopeDeps = {
    auth: deps.auth,
    db: deps.db,
    audit: deps.audit ?? createAuditService(createAuditLogRepository(deps.db)),
  };
  registerAuthErrorHandler(app, { report: deps.errorReporter });

  void app.register(fastifyCors, { origin: deps.trustedOrigin, credentials: true });

  // CSRF check for every state-changing route (auth-tenancy.md §4.1), including our /v1/auth/signup|
  // login|logout wrappers: they call `auth.api.*` directly, which skips Better Auth's own origin
  // check (that check lives in its HTTP router), so this hook is their only one. The routes still
  // bridged to Better Auth are GET-only, which the hook lets through. @fastify/cors already blocks a
  // *browser* reading a cross-origin response, but a non-preflighted "simple" cross-site form POST
  // still reaches the handler and executes before CORS ever comes into it — this hook is what
  // actually stops that.
  app.addHook('onRequest', async (request, reply) => {
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

  // The few Better Auth routes we expose (EXPOSED_AUTH_ROUTES in @truepath/auth, ADR-0022). Not a
  // catch-all: any other path is a 404 from Fastify, and Better Auth disables it too.
  registerAuthBridge(app, deps.auth);
  app.setNotFoundHandler(async (_request, reply) => {
    await reply.code(404).send({ error: 'not_found' });
  });

  // Routes register inside a plugin that loads *after* the rate-limit plugin, because the plugin
  // only sees routes added once it is loaded (Fastify plugins load asynchronously, in order).
  void registerRateLimit(app, deps.rateLimit);
  void app.register(async (scope) => {
    const limits: RouteLimits = {
      signupIp: ipLimit(deps.rateLimit, 'signup', LIMITS.signup.ip),
      loginIp: ipLimit(deps.rateLimit, 'login', LIMITS.login.ip),
      inviteAcceptIp: ipLimit(deps.rateLimit, 'invite-accept', LIMITS.inviteAccept.ip),
      loginEmail: createEmailLimiter(scope, deps.rateLimit, [
        { name: 'login', limit: LIMITS.login.email },
        { name: 'login-hourly', limit: LIMITS.login.emailHourly },
      ]),
    };
    registerAuthWrapperRoutes(scope, tenantDeps, limits);
    registerMeRoutes(scope, tenantDeps);
    registerOrgRoutes(scope, tenantDeps);
    registerInviteRoutes(scope, tenantDeps, limits);
    registerMemberRoutes(scope, tenantDeps);
  });

  app.decorate('appDeps', deps);

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    appDeps: AppDeps;
  }
}
