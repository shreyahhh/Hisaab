import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '@truepath/db';
import type { Auth } from '@truepath/auth';
import type { Role } from '@truepath/shared';

// A tenant seeded through Better Auth's own signup/verify/sign-in/createOrganization flow, not raw
// inserts — so tests get a real, valid session cookie without reverse-engineering Better Auth's
// cookie-signing format. Only the membership role (when not 'owner') and the store are inserted
// directly, since neither can come from a self-serve API call.

export interface RealTenant {
  readonly userId: string;
  readonly email: string;
  readonly organizationId: string;
  readonly storeId: string;
  /** A `Cookie` header value carrying the signed-in session. */
  readonly cookie: string;
}

const PASSWORD = 'a-very-long-password-123';

export async function seedRealTenant(
  auth: Auth,
  db: Db,
  label: string,
  role: Role = 'owner',
): Promise<RealTenant> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `real-tenant-${suffix}@example.invalid`;

  await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: `Tenant ${label}` } });
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  if (!user) throw new Error('seedRealTenant: signup did not create a user');
  await db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, user.id));

  const signIn = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  const cookie = signIn.headers.get('set-cookie');
  if (!cookie) throw new Error('seedRealTenant: sign-in did not return a session cookie');

  const org = await auth.api.createOrganization({
    body: { name: `Tenant ${label} Org`, slug: `real-tenant-${suffix}` },
    headers: new Headers({ cookie }),
  });
  if (!org) throw new Error('seedRealTenant: createOrganization failed');

  if (role !== 'owner') {
    // The API's own creator-role protections exist precisely to stop this — direct test setup only.
    await db
      .update(schema.memberships)
      .set({ role })
      .where(
        and(eq(schema.memberships.userId, user.id), eq(schema.memberships.organizationId, org.id)),
      );
  }

  const [store] = await db
    .insert(schema.stores)
    .values({ organizationId: org.id, shopDomain: `real-tenant-${suffix}.myshopify.com` })
    .returning({ id: schema.stores.id });
  if (!store) throw new Error('seedRealTenant: store insert failed');

  return { userId: user.id, email, organizationId: org.id, storeId: store.id, cookie };
}

export async function cleanupRealTenant(db: Db, tenant: RealTenant): Promise<void> {
  await db.delete(schema.organizations).where(eq(schema.organizations.id, tenant.organizationId)); // cascades store, membership, invites
  await db.delete(schema.authAccounts).where(eq(schema.authAccounts.userId, tenant.userId));
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, tenant.userId));
  await db.delete(schema.users).where(eq(schema.users.id, tenant.userId));
}

/** Adds a second, real user as a member of `tenant`'s organization at `role`, with their own session. */
export async function addRealMember(
  auth: Auth,
  db: Db,
  tenant: RealTenant,
  label: string,
  role: Role,
): Promise<RealTenant> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `real-member-${suffix}@example.invalid`;

  await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: `Member ${label}` } });
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  if (!user) throw new Error('addRealMember: signup did not create a user');
  await db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, user.id));

  const invitation = await auth.api.createInvitation({
    body: { email, role, organizationId: tenant.organizationId },
    headers: new Headers({ cookie: tenant.cookie }),
  });

  const signIn = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  const cookie = signIn.headers.get('set-cookie');
  if (!cookie) throw new Error('addRealMember: sign-in did not return a session cookie');

  await auth.api.acceptInvitation({
    body: { invitationId: invitation!.id },
    headers: new Headers({ cookie }),
  });

  return {
    userId: user.id,
    email,
    organizationId: tenant.organizationId,
    storeId: tenant.storeId,
    cookie,
  };
}

/**
 * Cleans up a member added by {@link addRealMember} (no organization of their own to delete). If
 * the member sent any invites of their own (e.g. an admin inviting a peer), those rows reference
 * them via `invites.inviter_id`, which has no cascade (auth-tenancy.md §3) — deleted first here
 * rather than relying on the organization's own cleanup to run first, since cleanup order across
 * a test's several tenants/members is otherwise whatever order the caller happens to pick.
 */
export async function cleanupRealMember(db: Db, member: RealTenant): Promise<void> {
  await db.delete(schema.invites).where(eq(schema.invites.inviterId, member.userId));
  await db.delete(schema.memberships).where(eq(schema.memberships.userId, member.userId));
  await db.delete(schema.authAccounts).where(eq(schema.authAccounts.userId, member.userId));
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, member.userId));
  await db.delete(schema.users).where(eq(schema.users.id, member.userId));
}

export function randomStoreId(): string {
  return randomUUID();
}

/** A verified, signed-in user with no organization — e.g. an invitee before they accept. */
export interface RealUser {
  readonly userId: string;
  readonly email: string;
  readonly cookie: string;
}

/** Signs up, verifies and signs in a user. Pass `email` to be the recipient of an existing invite. */
export async function seedRealUser(
  auth: Auth,
  db: Db,
  label: string,
  email?: string,
): Promise<RealUser> {
  const address =
    email ??
    `real-user-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
  await auth.api.signUpEmail({
    body: { email: address, password: PASSWORD, name: `User ${label}` },
  });
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, address));
  if (!user) throw new Error('seedRealUser: signup did not create a user');
  await db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, user.id));
  const signIn = await auth.api.signInEmail({
    body: { email: address, password: PASSWORD },
    asResponse: true,
  });
  const cookie = signIn.headers.get('set-cookie');
  if (!cookie) throw new Error('seedRealUser: sign-in did not return a session cookie');
  return { userId: user.id, email: address, cookie };
}

export async function cleanupRealUser(db: Db, user: RealUser): Promise<void> {
  await db.delete(schema.invites).where(eq(schema.invites.inviterId, user.userId));
  await db.delete(schema.memberships).where(eq(schema.memberships.userId, user.userId));
  await db.delete(schema.authAccounts).where(eq(schema.authAccounts.userId, user.userId));
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, user.userId));
  await db.delete(schema.users).where(eq(schema.users.id, user.userId));
}
