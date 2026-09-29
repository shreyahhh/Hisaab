import type { FastifyInstance } from 'fastify';
import {
  createConsentRecordRepository,
  createDsrRequestRepository,
  createSuppressedIdentityRepository,
} from '@truepath/db';
import {
  requirePermission,
  requireStoreScope,
  type TenantScopeDeps,
} from '../tenantScope.js';

/**
 * `GET /v1/stores/:id/privacy/consent-stats` and `GET /v1/stores/:id/privacy/requests` (SPEC §10).
 * Consent records store only an HMAC'd visitor id (SPEC v0.2 §6.1) and DSR rows carry a hashed
 * identity, never raw phone/email — nothing here needs additional redaction before it's returned.
 */
export function registerPrivacyDashboardRoutes(app: FastifyInstance, deps: TenantScopeDeps): void {
  app.get<{ Params: { storeId: string } }>(
    '/v1/stores/:storeId/privacy/consent-stats',
    { preHandler: [requireStoreScope(deps), requirePermission('privacy.requests')] },
    async (request, reply) => {
      const scope = request.scope!;
      const storeId = request.params.storeId;
      const [consentRecords, suppressedCount] = await Promise.all([
        createConsentRecordRepository(deps.db).listRecentByStore(scope, storeId, 20),
        createSuppressedIdentityRepository(deps.db).countByStore(scope, storeId),
      ]);
      await reply.send({
        suppressed_identities_count: suppressedCount,
        consent_records_recent: consentRecords.map((row) => ({
          state: row.state,
          purposes: row.purposes,
          source: row.source,
          notice_version: row.noticeVersion,
          occurred_at: row.occurredAt.toISOString(),
        })),
      });
    },
  );

  app.get<{ Params: { storeId: string } }>(
    '/v1/stores/:storeId/privacy/requests',
    { preHandler: [requireStoreScope(deps), requirePermission('privacy.requests')] },
    async (request, reply) => {
      const scope = request.scope!;
      const rows = await createDsrRequestRepository(deps.db).listRecentByStore(
        scope,
        request.params.storeId,
        20,
      );
      await reply.send({
        requests: rows.map((row) => ({
          id: row.id,
          type: row.type,
          status: row.status,
          created_at: row.createdAt.toISOString(),
          due_at: row.dueAt.toISOString(),
          completed_at: row.completedAt ? row.completedAt.toISOString() : null,
          trigger:
            row.resultSummary && typeof row.resultSummary === 'object'
              ? (row.resultSummary as Record<string, unknown>)['trigger'] ?? null
              : null,
        })),
        // M4-2 fulfils these rows (export/erasure); until then every request just sits `pending`.
        note: 'Processing (export/erasure) arrives in M4 — requests are recorded but not yet fulfilled.',
      });
    },
  );
}
