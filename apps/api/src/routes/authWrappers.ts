import { APIError } from 'better-auth/api';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { findUserIdByEmail } from '@truepath/auth';
import { createAuditLogRepository } from '@truepath/db';
import { normaliseEmail } from '@truepath/privacy';
import { forwardResponse, sendAuthApiError } from '../errors.js';
import type { RouteLimits } from '../rateLimit.js';
import { requireSession, type TenantScopeDeps } from '../tenantScope.js';

/**
 * Thin, SPEC-named wrappers around Better Auth's own routes (auth-tenancy.md §2.1) — the generic
 * `/v1/auth/*` bridge in app.ts already exposes Better Auth's default paths; these add the
 * friendlier `/v1/auth/signup|login|logout` names plus our own login audit trail (S-4), which the
 * generic bridge has no hook to add.
 *
 * login_failed's metadata holds no email and no hash of one (privacy-dpdp.md: audit metadata is ids
 * and counts only). It says which account the attempt targeted — `target_user_id` when the attempted
 * email belongs to a user, `unknown_account: true` when it doesn't — so an attack on one account is
 * visible in the trail without it storing what was typed.
 */
export function registerAuthWrapperRoutes(
  app: FastifyInstance,
  deps: TenantScopeDeps,
  limits: RouteLimits,
): void {
  app.post<{ Body: { email: string; password: string; name: string } }>(
    '/v1/auth/signup',
    { config: limits.signupIp },
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
    { config: limits.loginIp },
    async (request, reply) => {
      // Per-account limit as well as per-IP, so a guessing run spread across IPs is still capped.
      if (!(await limits.loginEmail(request, reply))) return;
      const auditLog = createAuditLogRepository(deps.db);

      // With `asResponse: true` Better Auth returns a 4xx Response for a wrong password rather than
      // throwing, so success is decided by the status, not by the absence of an exception.
      let response: Response | undefined;
      let failure: unknown;
      try {
        response = await deps.auth.api.signInEmail({ body: request.body, asResponse: true });
      } catch (error) {
        failure = error;
      }

      if (response?.ok) {
        await auditLog.recordGlobal({
          actorType: 'user',
          action: 'login_succeeded',
          targetType: 'auth',
          targetId: 'login',
        });
        await forwardResponse(reply, response);
        return;
      }

      // Anything that isn't a Better Auth rejection (a database outage, a bug) is a server error,
      // not a failed login: rethrow it rather than audit it as one.
      if (!response && !(failure instanceof APIError)) throw failure;

      const email =
        typeof request.body?.email === 'string' ? normaliseEmail(request.body.email) : null;
      const userId = email === null ? null : await findUserIdByEmail(deps.db, email);
      await auditLog.recordGlobal({
        actorType: 'user',
        action: 'login_failed',
        targetType: 'auth',
        targetId: 'login',
        metadata: userId === null ? { unknown_account: true } : { target_user_id: userId },
      });
      if (response) await forwardResponse(reply, response);
      else await sendAuthApiError(reply, failure);
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
