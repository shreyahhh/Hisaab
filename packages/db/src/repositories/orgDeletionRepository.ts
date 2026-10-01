import { eq } from 'drizzle-orm';
import { assertOrganizationInScope, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { invites, memberships, users } from '../schema/index.js';

// Issue #84 (auth-tenancy.md §4.6 step 4): the membership/invite/user half of org deletion. Spans
// three tables none of which belong to `organizationRepository.ts` (which owns only `organizations`
// itself).
//
// `auth_tokens` (Better Auth's verification table) is deliberately NOT touched here. It has no `user_id`
// column and no FK to `users` at all — its `identifier` is a self-contained value (e.g. a password
// reset row's identifier is `reset-password:<token>`, confirmed against Better Auth's own source),
// not the user's id or email. There is no reliable way to find "this user's" rows without assuming
// unverified internals of Better Auth's other flows. These rows expire on their own in minutes to
// hours and carry no PII beyond a token for a user who will no longer exist to redeem it — left to
// their own TTL rather than guessed at.

export interface EraseMembersAndInvitesResult {
  readonly membershipsDeleted: number;
  readonly invitesDeleted: number;
  readonly usersDeleted: number;
  /** A candidate had no other membership but couldn't be deleted (e.g. still an `inviterId` on a
   * different organization's pending invite — `invites.inviterId` has no `ON DELETE` clause). Not
   * fatal: logged by the caller, left in place. */
  readonly usersSkipped: number;
}

export interface OrgDeletionRepository {
  /**
   * One transaction: deletes every `memberships`/`invites` row for the organization, then deletes
   * every candidate user (one who had a membership here) who has no membership left in *any*
   * organization — cascading their `sessions`/`auth_accounts` via the existing `ON DELETE CASCADE`.
   * Idempotent: a second call on the same organization returns all-zero counts.
   */
  eraseMembersAndInvites(
    scope: Scope,
    organizationId: string,
  ): Promise<EraseMembersAndInvitesResult>;
}

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  // node-postgres errors surface through drizzle wrapped in a DrizzleQueryError whose `.cause` is
  // the actual pg error carrying `.code` (confirmed against this exact FK-violation shape in testing).
  return pgErrorCode((error as { cause?: unknown }).cause);
}

function isForeignKeyViolation(error: unknown): boolean {
  return pgErrorCode(error) === '23503';
}

/** The only sanctioned way to erase an organization's memberships/invites/orphaned users (ADR-0016). */
export function createOrgDeletionRepository(db: Db): OrgDeletionRepository {
  return {
    async eraseMembersAndInvites(scope, organizationId) {
      assertOrganizationInScope(scope, organizationId);
      return db.transaction(async (tx) => {
        const candidateRows = await tx
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(eq(memberships.organizationId, organizationId));
        const candidateIds = [...new Set(candidateRows.map((r) => r.userId))];

        const deletedMemberships = await tx
          .delete(memberships)
          .where(eq(memberships.organizationId, organizationId))
          .returning({ id: memberships.id });
        const deletedInvites = await tx
          .delete(invites)
          .where(eq(invites.organizationId, organizationId))
          .returning({ id: invites.id });

        let usersDeleted = 0;
        let usersSkipped = 0;
        for (const userId of candidateIds) {
          const [stillMember] = await tx
            .select({ id: memberships.id })
            .from(memberships)
            .where(eq(memberships.userId, userId))
            .limit(1);
          if (stillMember) continue; // belongs to another organization — keep

          try {
            const deleted = await tx.delete(users).where(eq(users.id, userId)).returning({
              id: users.id,
            });
            if (deleted.length > 0) usersDeleted += 1;
          } catch (error) {
            if (!isForeignKeyViolation(error)) throw error;
            usersSkipped += 1;
          }
        }

        return {
          membershipsDeleted: deletedMemberships.length,
          invitesDeleted: deletedInvites.length,
          usersDeleted,
          usersSkipped,
        };
      });
    },
  };
}
