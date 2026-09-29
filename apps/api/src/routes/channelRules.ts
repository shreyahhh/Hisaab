import type { FastifyInstance } from 'fastify';
import { createChannelRuleRepository } from '@truepath/db';
import { requirePermission, requireStoreScope, type TenantScopeDeps } from '../tenantScope.js';

/**
 * `GET /v1/stores/:id/channel-rules` (SPEC §10; the `PUT` half is a settings-write ticket, not this
 * one). Read-only for the dashboard's Settings page.
 */
export function registerChannelRuleRoutes(app: FastifyInstance, deps: TenantScopeDeps): void {
  app.get<{ Params: { storeId: string } }>(
    '/v1/stores/:storeId/channel-rules',
    { preHandler: [requireStoreScope(deps), requirePermission('reports.read')] },
    async (request, reply) => {
      const scope = request.scope!;
      const rows = await createChannelRuleRepository(deps.db).listByStore(
        scope,
        request.params.storeId,
      );
      await reply.send({
        channel_rules: rows.map((row) => ({
          id: row.id,
          priority: row.priority,
          match: row.match,
          channel: row.channel,
          sub_channel: row.subChannel,
        })),
      });
    },
  );
}
