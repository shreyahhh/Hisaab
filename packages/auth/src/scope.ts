import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '@truepath/db';
import type { Role } from '@truepath/shared';

export interface MembershipInfo {
  /** The membership row's own id — Better Auth's organization plugin calls this `memberId`. */
  readonly id: string;
  readonly role: Role;
}

/**
 * Reads a user's membership in an organization directly from Better Auth's own `memberships`
 * table — the one allowed exception to "Postgres only through packages/db" (ADR-0016,
 * auth-tenancy.md §3). This is the org-level half of building a TenantScope
 * (auth-tenancy.md §4.3 step 2a): a `:orgId` route resolves `(userId, orgId) → role` here before
 * any TenantScope exists, so it can't itself go through the scoped repository layer. Its only
 * sanctioned caller is the Fastify tenant-scope preHandler.
 */
export async function resolveMembership(
  db: Db,
  userId: string,
  organizationId: string,
): Promise<MembershipInfo | null> {
  const rows = await db
    .select({ id: schema.memberships.id, role: schema.memberships.role })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.userId, userId),
        eq(schema.memberships.organizationId, organizationId),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? { id: row.id, role: row.role } : null;
}

export interface OrganizationMembership {
  readonly organizationId: string;
  readonly role: Role;
}

/** Lists every organization a user belongs to — the data behind `GET /v1/me` (auth-tenancy.md §2.1). */
export async function resolveMembershipsForUser(
  db: Db,
  userId: string,
): Promise<OrganizationMembership[]> {
  const rows = await db
    .select({ organizationId: schema.memberships.organizationId, role: schema.memberships.role })
    .from(schema.memberships)
    .where(eq(schema.memberships.userId, userId));
  return rows;
}

export interface InvitationInfo {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: Role;
  readonly status: string;
  readonly expiresAt: Date;
  readonly inviterId: string;
}

/**
 * Reads an invitation from Better Auth's own `invites` table (same allowed exception as
 * `resolveMembership`). Used to re-validate an invitation *at acceptance* — Better Auth itself
 * checks pending/expiry/recipient-email there, but never that the inviter still has standing.
 */
export async function getInvitation(db: Db, invitationId: string): Promise<InvitationInfo | null> {
  const rows = await db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.id, invitationId))
    .limit(1);
  const row = rows[0];
  return row
    ? {
        id: row.id,
        organizationId: row.organizationId,
        email: row.email,
        role: row.role,
        status: row.status,
        expiresAt: row.expiresAt,
        inviterId: row.inviterId,
      }
    : null;
}

/**
 * The id of the user whose (already lowercased) email is `email`, or null. Same allowed exception
 * as `resolveMembership`: it reads Better Auth's own `users` table. Used only to say *which
 * account* a failed login targeted in the audit trail, so the trail never needs the email itself.
 */
export async function findUserIdByEmail(db: Db, email: string): Promise<string | null> {
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  return rows[0]?.id ?? null;
}
