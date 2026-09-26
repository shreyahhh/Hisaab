import type { FastifyInstance } from 'fastify';
import { resolveMembershipsForUser } from '@truepath/auth';
import type { TenantScopeDeps } from '../tenantScope.js';
import { requireSession } from '../tenantScope.js';

/** GET /v1/me (auth-tenancy.md §2.1) — session only, no TenantScope: a user always sees their own profile. */
export function registerMeRoutes(app: FastifyInstance, deps: TenantScopeDeps): void {
  app.get('/v1/me', async (request, reply) => {
    const session = await requireSession(deps, request, reply);
    if (!session) return;

    const memberships = await resolveMembershipsForUser(deps.db, session.user.id);

    await reply.send({
      user: session.user,
      memberships: memberships.map((m) => ({ organizationId: m.organizationId, role: m.role })),
    });
  });
}
