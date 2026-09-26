import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { createAuditLogRepository } from '@truepath/db';
import { isAtOrBelowOwnRank, RoleSchema } from '@truepath/shared';
import {
  requireOrgScope,
  requirePermission,
  requireSession,
  type TenantScopeDeps,
} from '../tenantScope.js';

/**
 * `POST /v1/orgs/:id/invites`, `POST /v1/invites/:token/accept` (SPEC §10; auth-tenancy.md §2.1,
 * §4.2). The `:token` path segment is the invitation's own id — the accept link Better Auth's
 * `sendInvitationEmail` builds is `${DASHBOARD_URL}/invite/<id>` (betterAuth.ts).
 */
export function registerInviteRoutes(app: FastifyInstance, deps: TenantScopeDeps): void {
  app.post<{ Params: { id: string }; Body: { email: string; role: string } }>(
    '/v1/orgs/:id/invites',
    { preHandler: [requireOrgScope(deps), requirePermission('team.manage')] },
    async (request, reply) => {
      const scope = request.scope!;
      const role = RoleSchema.parse(request.body.role);
      // Nobody can invite at a role above their own — auth-tenancy.md §2.1's "admins can't invite
      // owners" is the only case this hierarchy produces today (admin inviting admin is same-rank,
      // allowed). Better Auth's own creatorRole check only blocks *changing* an existing member's
      // role, not inviting a new one at a given role, so this has no equivalent upstream.
      if (scope.role !== 'job' && !isAtOrBelowOwnRank(scope.role, role)) {
        await reply.code(403).send({ error: 'forbidden_role' });
        return;
      }

      const invitation = await deps.auth.api.createInvitation({
        body: { email: request.body.email, role, organizationId: scope.organizationId },
        headers: fromNodeHeaders(request.headers),
      });

      await createAuditLogRepository(deps.db).record(scope, {
        organizationId: scope.organizationId,
        actorUserId: scope.userId,
        actorType: 'user',
        action: 'member_invited',
        targetType: 'invite',
        targetId: invitation.id,
        metadata: { role },
      });

      await reply.code(201).send(invitation);
    },
  );

  app.post<{ Params: { token: string } }>('/v1/invites/:token/accept', async (request, reply) => {
    const session = await requireSession(deps, request, reply);
    if (!session) return;

    const result = await deps.auth.api.acceptInvitation({
      body: { invitationId: request.params.token },
      headers: fromNodeHeaders(request.headers),
    });

    if (result?.invitation) {
      await createAuditLogRepository(deps.db).record(
        {
          kind: 'tenant',
          userId: session.user.id,
          organizationId: result.invitation.organizationId,
          role: 'job',
          storeIds: new Set(),
        },
        {
          organizationId: result.invitation.organizationId,
          actorUserId: session.user.id,
          actorType: 'user',
          action: 'member_invite_accepted',
          targetType: 'invite',
          targetId: result.invitation.id,
        },
      );
    }

    await reply.send(result);
  });
}
