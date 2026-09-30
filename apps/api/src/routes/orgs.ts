import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createAuditLogRepository,
  createOrganizationRepository,
  createStoreRepository,
  InvalidAuditCursorError,
  MAX_AUDIT_PAGE_SIZE,
} from '@truepath/db';
import type { CredentialsCipher } from '@truepath/privacy';
import { AUDIT_ACTIONS, type TenantScope } from '@truepath/shared';
import type { Redis } from 'ioredis';
import { authCall } from '../authCall.js';
import { publishCollectorConfig } from '../shopifyPixel.js';
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

const DeleteOrgBodySchema = z.object({ name: z.string().min(1).max(200) }).strict();

export interface OrgDeletionRouteOptions {
  readonly dpaVersion: string;
  /** ADR-0023 envelope encryption — needed to republish a store's collector config after a status change. */
  readonly cipher: CredentialsCipher;
  /** Durable Redis — where `collector:store:<store_key>` configs live. */
  readonly redis: Redis;
}

/**
 * Every store's collector config reflects the organization's current status (issue #8;
 * `publishCollectorConfig` in `@truepath/db` checks it directly). Best-effort and non-blocking, same
 * as the DPA-accept route's republish: a store with no active Shopify integration yet is a harmless
 * no-op, and a Redis error for one store is logged (ids only) and doesn't fail the response or block
 * the other stores — the next suppression rebuild catches it up regardless.
 */
async function republishCollectorConfigs(
  deps: TenantScopeDeps,
  options: OrgDeletionRouteOptions,
  scope: TenantScope,
): Promise<void> {
  const stores = await createStoreRepository(deps.db).listByOrganization(
    scope,
    scope.organizationId,
  );
  await Promise.all(
    stores.map(async (store) => {
      try {
        await publishCollectorConfig(
          {
            db: deps.db,
            cipher: options.cipher,
            redis: options.redis,
            dpaVersion: options.dpaVersion,
          },
          scope,
          store.id,
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'collector_config_republish_failed',
            store_id: store.id,
            error_name: error instanceof Error ? error.name : 'unknown',
          }),
        );
      }
    }),
  );
}

/**
 * `POST/GET /v1/orgs`, `GET /v1/orgs/:id/stores`, `GET /v1/orgs/:id/audit-log`,
 * `DELETE /v1/orgs/:id`, `POST /v1/orgs/:id/deletion/cancel` (SPEC §10; auth-tenancy.md §2.1, §2.4,
 * §4.6).
 */
export function registerOrgRoutes(
  app: FastifyInstance,
  deps: TenantScopeDeps,
  orgDeletion: OrgDeletionRouteOptions,
): void {
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

  // DELETE /v1/orgs/:id (auth-tenancy.md §4.6, issue #8). Owner only (`org.delete`); the org's
  // current name must be typed as confirmation (the dashboard's export-first step happens before this
  // call, not here). Sets `pending_deletion` with a 7-day grace period and a 30-day completion
  // deadline (SPEC §5.7), and deactivates every store's collector config. The actual erasure once the
  // grace period elapses is a separate scheduler (LLD §4.6 steps 4-5), not built by this ticket — see
  // the issue tracking it.
  app.delete<{ Params: { id: string }; Body: unknown }>(
    '/v1/orgs/:id',
    { preHandler: [requireOrgScope(deps), requirePermission('org.delete')] },
    async (request, reply) => {
      const scope = request.scope!;
      const body = DeleteOrgBodySchema.safeParse(request.body);
      if (!body.success) {
        await reply.code(400).send({ error: 'invalid_body', fields: ['name'] });
        return;
      }

      const org = await createOrganizationRepository(deps.db).getById(scope, scope.organizationId);
      if (!org) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (body.data.name !== org.name) {
        await reply.code(400).send({ error: 'name_mismatch' });
        return;
      }
      if (org.status !== 'active') {
        await reply.code(409).send({
          error: org.status === 'deleted' ? 'org_already_deleted' : 'deletion_already_requested',
        });
        return;
      }

      const now = new Date();
      const updated = await deps.db.transaction(async (tx) => {
        const row = await createOrganizationRepository(tx).requestDeletion(
          scope,
          scope.organizationId,
          {
            now,
          },
        );
        if (row) {
          const metadata = row.metadata as Record<string, unknown>;
          await createAuditLogRepository(tx).write(scope, {
            organizationId: scope.organizationId,
            actorUserId: scope.userId,
            actorType: 'user',
            action: 'org_deletion_requested',
            targetType: 'organization',
            targetId: scope.organizationId,
            metadata: {
              deletion_scheduled_at: String(metadata.deletion_scheduled_at),
              deletion_due_by: String(metadata.deletion_due_by),
            },
          });
        }
        return row;
      });

      if (!updated) {
        await reply.code(409).send({ error: 'deletion_already_requested' });
        return;
      }

      await republishCollectorConfigs(deps, orgDeletion, scope);

      const metadata = updated.metadata as Record<string, unknown>;
      await reply.send({
        status: updated.status,
        deletion_scheduled_at: metadata.deletion_scheduled_at,
        deletion_due_by: metadata.deletion_due_by,
      });
    },
  );

  // POST /v1/orgs/:id/deletion/cancel (auth-tenancy.md §4.6 Open question 1, SPEC v0.6 §10). Owner
  // only, within the 7-day grace period — enforced atomically in `cancelDeletion`'s WHERE clause, not
  // just checked and then trusted.
  app.post<{ Params: { id: string } }>(
    '/v1/orgs/:id/deletion/cancel',
    { preHandler: [requireOrgScope(deps), requirePermission('org.delete')] },
    async (request, reply) => {
      const scope = request.scope!;
      const now = new Date();
      const updated = await deps.db.transaction(async (tx) => {
        const row = await createOrganizationRepository(tx).cancelDeletion(
          scope,
          scope.organizationId,
          {
            now,
          },
        );
        if (row) {
          await createAuditLogRepository(tx).write(scope, {
            organizationId: scope.organizationId,
            actorUserId: scope.userId,
            actorType: 'user',
            action: 'org_deletion_cancelled',
            targetType: 'organization',
            targetId: scope.organizationId,
          });
        }
        return row;
      });

      if (!updated) {
        await reply.code(409).send({ error: 'not_cancellable' });
        return;
      }

      await republishCollectorConfigs(deps, orgDeletion, scope);

      await reply.send({ status: updated.status });
    },
  );
}
