import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { createAuditLogRepository, createStoreRepository } from '@truepath/db';
import {
  requireOrgScope,
  requirePermission,
  requireSession,
  type TenantScopeDeps,
} from '../tenantScope.js';

/**
 * `POST/GET /v1/orgs`, `GET /v1/orgs/:id/stores`, `GET /v1/orgs/:id/audit-log`
 * (SPEC §10; auth-tenancy.md §2.1, §2.4).
 */
export function registerOrgRoutes(app: FastifyInstance, deps: TenantScopeDeps): void {
  app.post<{ Body: { name: string; slug: string } }>('/v1/orgs', async (request, reply) => {
    const session = await requireSession(deps, request, reply);
    if (!session) return;

    const org = await deps.auth.api.createOrganization({
      body: { name: request.body.name, slug: request.body.slug },
      headers: fromNodeHeaders(request.headers),
    });
    await reply.code(201).send(org);
  });

  app.get('/v1/orgs', async (request, reply) => {
    const session = await requireSession(deps, request, reply);
    if (!session) return;

    const organizations = await deps.auth.api.listOrganizations({
      headers: fromNodeHeaders(request.headers),
    });
    await reply.send({ organizations });
  });

  app.get<{ Params: { id: string } }>(
    '/v1/orgs/:id/stores',
    { preHandler: [requireOrgScope(deps), requirePermission('reports.read')] },
    async (request, reply) => {
      const scope = request.scope!;
      const stores = await createStoreRepository(deps.db).listByOrganization(
        scope,
        scope.organizationId,
      );
      await reply.send({ stores });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/v1/orgs/:id/audit-log',
    { preHandler: [requireOrgScope(deps), requirePermission('audit.read')] },
    async (request, reply) => {
      const scope = request.scope!;
      const limit = request.query.limit ? Number(request.query.limit) : undefined;
      const entries = await createAuditLogRepository(deps.db).listByOrganization(
        scope,
        scope.organizationId,
        { limit },
      );
      await createAuditLogRepository(deps.db).record(scope, {
        organizationId: scope.organizationId,
        actorUserId: scope.userId,
        actorType: 'user',
        action: 'audit_log_viewed',
        targetType: 'organization',
        targetId: scope.organizationId,
      });
      await reply.send({ entries });
    },
  );
}
