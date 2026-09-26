import { fromNodeHeaders } from 'better-auth/node';
import { APIError } from 'better-auth/api';
import type { FastifyInstance } from 'fastify';
import { createAuditLogRepository } from '@truepath/db';
import { resolveMembership } from '@truepath/auth';
import { can, RoleSchema } from '@truepath/shared';
import { requireOrgScope, type TenantScopeDeps } from '../tenantScope.js';
import { sendAuthApiError } from '../errors.js';

// Better Auth uses a different code for updateMemberRole (demoting the last owner) than for
// removeMember (removing the last owner) — confirmed by exercising both against a real instance.
const LAST_OWNER_CODES = new Set([
  'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER',
  'YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER',
]);

/**
 * `PUT/DELETE /v1/orgs/:id/members/:userId` (SPEC §10; auth-tenancy.md §2.1, §2.4):
 * - `team.manage` is owner + admin, but **admins can only manage analyst/viewer members** — Better
 *   Auth's own creator-role guard stops a non-owner touching an *owner*, but not admin-vs-admin.
 * - Removing (never role-changing) yourself is always allowed, at any role.
 * - The last owner can't be demoted or removed — Better Auth's own guard, mapped to `409 last_owner`.
 */
export function registerMemberRoutes(app: FastifyInstance, deps: TenantScopeDeps): void {
  app.put<{ Params: { id: string; userId: string }; Body: { role: string } }>(
    '/v1/orgs/:id/members/:userId',
    { preHandler: [requireOrgScope(deps)] },
    async (request, reply) => {
      const scope = request.scope!;
      if (!can(scope, 'team.manage')) {
        await reply.code(403).send({ error: 'forbidden_role' });
        return;
      }

      const target = await resolveMembership(deps.db, request.params.userId, scope.organizationId);
      if (!target) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (scope.role === 'admin' && target.role !== 'analyst' && target.role !== 'viewer') {
        await reply.code(403).send({ error: 'forbidden_role' });
        return;
      }

      const newRole = RoleSchema.parse(request.body.role);
      try {
        const result = await deps.auth.api.updateMemberRole({
          body: { memberId: target.id, role: newRole, organizationId: scope.organizationId },
          headers: fromNodeHeaders(request.headers),
        });
        await createAuditLogRepository(deps.db).record(scope, {
          organizationId: scope.organizationId,
          actorUserId: scope.userId,
          actorType: 'user',
          action: 'member_role_changed',
          targetType: 'user',
          targetId: request.params.userId,
          metadata: { from: target.role, to: newRole },
        });
        await reply.send(result);
      } catch (error) {
        if (
          error instanceof APIError &&
          error.body?.code &&
          LAST_OWNER_CODES.has(error.body.code)
        ) {
          await reply.code(409).send({ error: 'last_owner' });
          return;
        }
        await sendAuthApiError(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/v1/orgs/:id/members/:userId',
    { preHandler: [requireOrgScope(deps)] },
    async (request, reply) => {
      const scope = request.scope!;
      const isSelf = request.params.userId === scope.userId;
      if (!isSelf && !can(scope, 'team.manage')) {
        await reply.code(403).send({ error: 'forbidden_role' });
        return;
      }

      const target = await resolveMembership(deps.db, request.params.userId, scope.organizationId);
      if (!target) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (
        !isSelf &&
        scope.role === 'admin' &&
        target.role !== 'analyst' &&
        target.role !== 'viewer'
      ) {
        await reply.code(403).send({ error: 'forbidden_role' });
        return;
      }

      try {
        // Better Auth's removeMember checks the ACTOR's own member:delete permission — viewer and
        // analyst have none, so it would reject even a self-removal. /organization/leave is the
        // dedicated, permission-free (besides the last-owner guard) self-removal endpoint.
        const result = isSelf
          ? await deps.auth.api.leaveOrganization({
              body: { organizationId: scope.organizationId },
              headers: fromNodeHeaders(request.headers),
            })
          : await deps.auth.api.removeMember({
              body: { memberIdOrEmail: target.id, organizationId: scope.organizationId },
              headers: fromNodeHeaders(request.headers),
            });
        await createAuditLogRepository(deps.db).record(scope, {
          organizationId: scope.organizationId,
          actorUserId: scope.userId,
          actorType: 'user',
          action: 'member_removed',
          targetType: 'user',
          targetId: request.params.userId,
          metadata: { role: target.role, self: isSelf },
        });
        await reply.send(result);
      } catch (error) {
        if (
          error instanceof APIError &&
          error.body?.code &&
          LAST_OWNER_CODES.has(error.body.code)
        ) {
          await reply.code(409).send({ error: 'last_owner' });
          return;
        }
        await sendAuthApiError(reply, error);
      }
    },
  );
}
