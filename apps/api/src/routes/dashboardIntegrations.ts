import type { FastifyInstance } from 'fastify';
import { createIntegrationRepository } from '@truepath/db';
import {
  requirePermission,
  requireStoreScope,
  type TenantScopeDeps,
} from '../tenantScope.js';

/**
 * `GET /v1/stores/:storeId/integrations` (SPEC §10). Read-only view of every provider the store
 * has connected — never returns `encrypted_credentials`, only status/scopes/settings (which per
 * HLD §8's "Secrets rule" never holds a secret).
 */
export function registerDashboardIntegrationRoutes(
  app: FastifyInstance,
  deps: TenantScopeDeps,
): void {
  app.get<{ Params: { storeId: string } }>(
    '/v1/stores/:storeId/integrations',
    { preHandler: [requireStoreScope(deps), requirePermission('reports.read')] },
    async (request, reply) => {
      const scope = request.scope!;
      const rows = await createIntegrationRepository(deps.db).listByStore(
        scope,
        request.params.storeId,
      );
      await reply.send({
        integrations: rows.map((row) => ({
          id: row.id,
          provider: row.provider,
          status: row.status,
          scopes: row.scopes ?? [],
          connected_at: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
          error: row.error,
          settings: row.settings,
        })),
      });
    },
  );
}
