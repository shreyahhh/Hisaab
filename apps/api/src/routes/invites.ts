import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { createAuditLogRepository } from '@truepath/db';
import { getInvitation, resolveMembership } from '@truepath/auth';
import { isAtOrBelowOwnRank, RoleSchema, roleCan } from '@truepath/shared';
import { sendAuthApiError } from '../errors.js';
import type { RouteLimits } from '../rateLimit.js';
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
export function registerInviteRoutes(
  app: FastifyInstance,
  deps: TenantScopeDeps,
  limits: RouteLimits,
): void {
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

  app.post<{ Params: { token: string } }>(
    '/v1/invites/:token/accept',
    { config: limits.inviteAcceptIp },
    async (request, reply) => {
      const session = await requireSession(deps, request, reply);
      if (!session) return;

      // Better Auth checks pending/expiry/recipient-email at acceptance but never that the
      // *inviter* still has standing. An invite outlives the person who sent it: demote or remove
      // an admin and their still-pending "admin" invite would otherwise mint an admin. So the
      // ceiling is enforced again here, against the inviter's role *now* (auth-tenancy.md §2.1).
      // Recipient-email is checked first so a non-recipient learns nothing about the invite.
      const invitation = await getInvitation(deps.db, request.params.token);
      if (invitation && invitation.status === 'pending') {
        if (invitation.email.toLowerCase() !== session.user.email.toLowerCase()) {
          await reply.code(403).send({ error: 'invite_email_mismatch' });
          return;
        }
        const inviter = await resolveMembership(
          deps.db,
          invitation.inviterId,
          invitation.organizationId,
        );
        const inviterStillAuthorised =
          inviter !== null &&
          roleCan(inviter.role, 'team.manage') &&
          isAtOrBelowOwnRank(inviter.role, invitation.role);
        if (!inviterStillAuthorised) {
          await reply.code(403).send({ error: 'invite_no_longer_valid' });
          return;
        }
      }

      try {
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
      } catch (error) {
        await sendAuthApiError(reply, error);
      }
    },
  );
}
