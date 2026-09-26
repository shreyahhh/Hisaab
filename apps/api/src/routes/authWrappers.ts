import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { createAuditLogRepository } from '@truepath/db';
import { forwardResponse, sendAuthApiError } from '../errors.js';
import { requireSession, type TenantScopeDeps } from '../tenantScope.js';

/**
 * Thin, SPEC-named wrappers around Better Auth's own routes (auth-tenancy.md §2.1) — the generic
 * `/v1/auth/*` bridge in app.ts already exposes Better Auth's default paths; these add the
 * friendlier `/v1/auth/signup|login|logout` names plus our own login audit trail (S-4), which the
 * generic bridge has no hook to add.
 *
 * login_failed's metadata carries no identifier at all, not even the attempted email — hashing it
 * needs packages/privacy's HMAC helper, which lands in M0-5, and "no identifier" is the safe
 * interim over storing one in the wrong (unhashed) shape.
 */
export function registerAuthWrapperRoutes(app: FastifyInstance, deps: TenantScopeDeps): void {
  app.post<{ Body: { email: string; password: string; name: string } }>(
    '/v1/auth/signup',
    async (request, reply) => {
      try {
        const response = await deps.auth.api.signUpEmail({
          body: request.body,
          asResponse: true,
        });
        await forwardResponse(reply, response);
      } catch (error) {
        await sendAuthApiError(reply, error);
      }
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    '/v1/auth/login',
    async (request, reply) => {
      const auditLog = createAuditLogRepository(deps.db);
      try {
        const response = await deps.auth.api.signInEmail({ body: request.body, asResponse: true });
        await auditLog.recordGlobal({
          actorType: 'user',
          action: 'login_succeeded',
          targetType: 'auth',
          targetId: 'login',
        });
        await forwardResponse(reply, response);
      } catch (error) {
        await auditLog.recordGlobal({
          actorType: 'user',
          action: 'login_failed',
          targetType: 'auth',
          targetId: 'login',
        });
        await sendAuthApiError(reply, error);
      }
    },
  );

  app.post('/v1/auth/logout', async (request, reply) => {
    const session = await requireSession(deps, request, reply);
    if (!session) return;
    try {
      const response = await deps.auth.api.signOut({
        headers: fromNodeHeaders(request.headers),
        asResponse: true,
      });
      await forwardResponse(reply, response);
    } catch (error) {
      await sendAuthApiError(reply, error);
    }
  });
}
