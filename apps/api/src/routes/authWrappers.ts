import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { findUserIdByEmail } from '@truepath/auth';
import { normaliseEmail } from '@truepath/privacy';
import { AuthApiError, authCall } from '../authCall.js';
import { forwardResponse } from '../errors.js';
import type { RouteLimits } from '../rateLimit.js';
import { requireSession, type TenantScopeDeps } from '../tenantScope.js';

/**
 * Thin, SPEC-named wrappers around Better Auth's own routes (auth-tenancy.md §2.1) — the generic
 * `/v1/auth/*` bridge in app.ts already exposes Better Auth's default paths; these add the
 * friendlier `/v1/auth/signup|login|logout` names plus our own login audit trail (S-4), which the
 * generic bridge has no hook to add.
 *
 * These call Better Auth with `asResponse: true`, which returns a 4xx Response on failure instead
 * of throwing; `authCall` turns that into an AuthApiError, and app.ts maps an uncaught one to
 * `{ error: <code> }` with Better Auth's status.
 *
 * Better Auth has already created the session (or refused) by the time the audit row is written, so
 * these use the after-commit writer: a failing audit write never turns the real response into a 500
 * (ADR-0021).
 *
 * login_failed's metadata holds no email and no hash of one (privacy-dpdp.md: audit metadata is ids
 * and counts only). It says which account the attempt targeted — `target_user_id` when the attempted
 * email belongs to a user, `unknown_account: true` when it doesn't — so an attack on one account is
 * visible in the trail without it storing what was typed. login_succeeded carries no such metadata
 * (nothing to say beyond "it happened"), so it records `actorUserId` instead — also the fix for
 * issue #57: a platform-wide row's own test can no longer be confused with a concurrent suite's.
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
      const response = await authCall(() =>
        deps.auth.api.signUpEmail({ body: request.body, asResponse: true }),
      );
      await forwardResponse(reply, response);
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    '/v1/auth/login',
    { config: limits.loginIp },
    async (request, reply) => {
      // Per-account limit as well as per-IP, so a guessing run spread across IPs is still capped.
      if (!(await limits.loginEmail(request, reply))) return;
      let response: Response;
      try {
        response = await authCall(() =>
          deps.auth.api.signInEmail({ body: request.body, asResponse: true }),
        );
      } catch (error) {
        // Anything that isn't a Better Auth rejection (a database outage, a bug) is a server error,
        // not a failed login: it propagates unaudited.
        if (!(error instanceof AuthApiError)) throw error;
        const email =
          typeof request.body?.email === 'string' ? normaliseEmail(request.body.email) : null;
        const userId = email === null ? null : await findUserIdByEmail(deps.db, email);
        await deps.audit.afterCommitPlatform({
          actorType: 'user',
          action: 'login_failed',
          targetType: 'auth',
          targetId: 'login',
          metadata: userId === null ? { unknown_account: true } : { target_user_id: userId },
        });
        throw error;
      }

      const normalisedEmail = normaliseEmail(request.body.email);
      await deps.audit.afterCommitPlatform({
        actorUserId:
          normalisedEmail === null ? null : await findUserIdByEmail(deps.db, normalisedEmail),
        actorType: 'user',
        action: 'login_succeeded',
        targetType: 'auth',
        targetId: 'login',
      });
      await forwardResponse(reply, response);
    },
  );

  app.post('/v1/auth/logout', async (request, reply) => {
    const session = await requireSession(deps, request, reply);
    if (!session) return;
    const response = await authCall(() =>
      deps.auth.api.signOut({ headers: fromNodeHeaders(request.headers), asResponse: true }),
    );
    await forwardResponse(reply, response);
  });
}
