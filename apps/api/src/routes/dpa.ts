import type { FastifyInstance } from 'fastify';
import { truncateIp } from '@truepath/auth';
import { createAuditLogRepository, createDpaAcceptanceRepository } from '@truepath/db';
import { DpaAcceptBodySchema, type DpaAcceptResponse } from '@truepath/shared';
import { requireOrgScope, requirePermission, type TenantScopeDeps } from '../tenantScope.js';

/**
 * `POST /v1/orgs/:id/dpa/accept` (SPEC §5.1, §10; auth-tenancy.md §4.5; privacy-dpdp.md §2.2).
 *
 * Owner only (`dpa.accept`). The body names the DPA version being accepted, which must be the one
 * this deployment requires (`dpaVersion`, from the DPA_VERSION env var): accepting an old or unknown
 * text is `409 dpa_version_mismatch`, so nobody can satisfy the tracking gate with the wrong document.
 *
 * The acceptance row and its `dpa_accepted` audit row commit in one transaction, so there is never an
 * acceptance without its audit entry (or the reverse). Accepting a version the organization has
 * already accepted is a no-op that returns the existing record with `200`, and writes no second row
 * or audit entry. The accepting IP is stored truncated to /24 (IPv4) or /48 (IPv6), never in full.
 *
 * Not done here: republishing the Collector store configs so tracking can switch on
 * (privacy-dpdp.md §4.10). The Collector does not exist yet; that lands with M1-5.
 */
export function registerDpaRoutes(
  app: FastifyInstance,
  deps: TenantScopeDeps,
  options: { readonly dpaVersion: string },
): void {
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/orgs/:id/dpa/accept',
    { preHandler: [requireOrgScope(deps), requirePermission('dpa.accept')] },
    async (request, reply) => {
      const scope = request.scope!;

      // Validated in the handler, after the preHandlers, so a foreign organization gets its 404 (and a
      // wrong role its 403) whatever it sends.
      const body = DpaAcceptBodySchema.safeParse(request.body);
      if (!body.success) {
        await reply.code(400).send({
          error: 'invalid_body',
          fields: [...new Set(body.error.issues.map((issue) => issue.path.join('.') || '(root)'))],
        });
        return;
      }
      if (body.data.dpa_version !== options.dpaVersion) {
        await reply
          .code(409)
          .send({ error: 'dpa_version_mismatch', current_version: options.dpaVersion });
        return;
      }

      const { row, created } = await deps.db.transaction(async (tx) => {
        const result = await createDpaAcceptanceRepository(tx).record(scope, {
          organizationId: scope.organizationId,
          dpaVersion: options.dpaVersion,
          acceptedByUserId: scope.userId!,
          ipTruncated: truncateIp(request.ip),
        });
        if (result.created) {
          await createAuditLogRepository(tx).write(scope, {
            organizationId: scope.organizationId,
            actorUserId: scope.userId,
            actorType: 'user',
            action: 'dpa_accepted',
            targetType: 'organization',
            targetId: scope.organizationId,
            metadata: { dpa_version: options.dpaVersion },
          });
        }
        return result;
      });

      const response: DpaAcceptResponse = {
        id: row.id,
        dpa_version: row.dpaVersion,
        accepted_at: row.acceptedAt.toISOString(),
      };
      await reply.code(created ? 201 : 200).send(response);
    },
  );
}
