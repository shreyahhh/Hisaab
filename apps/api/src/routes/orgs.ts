import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createStoreRepository, InvalidAuditCursorError, MAX_AUDIT_PAGE_SIZE } from '@truepath/db';
import { AUDIT_ACTIONS } from '@truepath/shared';
import { authCall } from '../authCall.js';
import {
  requireOrgScope,
  requirePermission,
  requireSession,
  type TenantScopeDeps,
} from '../tenantScope.js';

const AuditLogQuery = z
  .object({
    from: z.string().datetime({ offset: true }).pipe(z.coerce.date()).optional(),
    to: z.string().datetime({ offset: true }).pipe(z.coerce.date()).optional(),
    action: z.enum(AUDIT_ACTIONS).optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_AUDIT_PAGE_SIZE).optional(),
  })
  .strict();

/**
 * `POST/GET /v1/orgs`, `GET /v1/orgs/:id/stores`, `GET /v1/orgs/:id/audit-log`
 * (SPEC §10; auth-tenancy.md §2.1, §2.4).
 */
export function registerOrgRoutes(app: FastifyInstance, deps: TenantScopeDeps): void {
  app.post<{ Body: { name: string; slug: string } }>('/v1/orgs', async (request, reply) => {
    const session = await requireSession(deps, request, reply);
    if (!session) return;

    const org = await authCall(() =>
      deps.auth.api.createOrganization({
        body: { name: request.body.name, slug: request.body.slug },
        headers: fromNodeHeaders(request.headers),
      }),
    );
    await reply.code(201).send(org);
  });

  app.get('/v1/orgs', async (request, reply) => {
    const session = await requireSession(deps, request, reply);
    if (!session) return;

    const organizations = await authCall(() =>
      deps.auth.api.listOrganizations({ headers: fromNodeHeaders(request.headers) }),
    );
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

  // GET /v1/orgs/:id/audit-log (privacy-dpdp.md §2.2). Query validation runs in the handler, after
  // the preHandlers, so a foreign organization gets its 404 whatever it sends.
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    '/v1/orgs/:id/audit-log',
    { preHandler: [requireOrgScope(deps), requirePermission('audit.read')] },
    async (request, reply) => {
      const scope = request.scope!;
      const query = AuditLogQuery.safeParse(request.query);
      if (!query.success || (query.data.from && query.data.to && query.data.from > query.data.to)) {
        await reply.code(400).send({
          error: 'invalid_query',
          fields: query.success
            ? ['from', 'to']
            : [...new Set(query.error.issues.map((i) => i.path.join('.')))],
        });
        return;
      }
      const { from, to, action, cursor, limit } = query.data;
      const options = {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(action ? { action } : {}),
        ...(cursor ? { cursor } : {}),
        ...(limit ? { limit } : {}),
      };

      let page;
      try {
        page = await deps.audit.log.list(scope, scope.organizationId, options);
      } catch (error) {
        if (error instanceof InvalidAuditCursorError) {
          await reply.code(400).send({ error: 'invalid_query', fields: ['cursor'] });
          return;
        }
        throw error;
      }

      // Viewing the log is itself audited, once per visit: the first page only, so paging through a
      // long log doesn't bury it in its own rows. This is our own read, not a committed action, so the
      // write is not optional — if it fails the request fails, and no data is returned unaudited.
      if (!cursor) {
        await deps.audit.log.write(scope, {
          organizationId: scope.organizationId,
          actorUserId: scope.userId,
          actorType: 'user',
          action: 'audit_log_viewed',
          targetType: 'organization',
          targetId: scope.organizationId,
        });
      }

      await reply.send({
        items: page.items.map((row) => ({
          id: row.id,
          action: row.action,
          actor_type: row.actorType,
          actor_user_id: row.actorUserId,
          target_type: row.targetType,
          target_id: row.targetId,
          metadata: row.metadata,
          created_at: row.createdAt.toISOString(),
        })),
        next_cursor: page.nextCursor,
      });
    },
  );
}
