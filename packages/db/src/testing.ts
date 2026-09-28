// Real-Postgres test fixtures for this package's own tests and for other packages/apps whose
// tenancy tests need to seed genuine tenants rather than mocks (CLAUDE.md: "run tests against the
// real local Docker databases ... for anything touching tenancy"). Exported as a separate
// `@truepath/db/testing` entry point so these fixtures never ship as part of the package's normal
// runtime surface ("."). Not a repository: it writes directly, bypassing scope checks, because
// seeding test data is the test's job, not the thing under test.

import { eq } from 'drizzle-orm';
import { loadDotEnvIfPresent, loadEnv, postgresEnvSchema, type Role } from '@truepath/shared';
import { createDb, type Db } from './client.js';
import { auditLog, memberships, organizations, stores, users } from './schema/index.js';

loadDotEnvIfPresent('../../.env');
const env = loadEnv(postgresEnvSchema);

/** Shared connection for tests in this process — real local Postgres (docker-compose). */
export const db: Db = createDb(env.DATABASE_URL);

export interface TestTenant {
  readonly organizationId: string;
  readonly storeId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly role: Role;
}

let seedCounter = 0;

/**
 * Inserts a fresh user + organization + membership + store, unique per call, for use as a test
 * tenant. Defaults the membership to `owner` — the common case for tenancy tests.
 */
export async function seedTestTenant(label: string, role: Role = 'owner'): Promise<TestTenant> {
  seedCounter += 1;
  const suffix = `${Date.now()}-${seedCounter}-${label}`;

  const [user] = await db
    .insert(users)
    .values({ email: `test-${suffix}@example.invalid`, name: `Test User ${suffix}` })
    .returning({ id: users.id });
  const [org] = await db
    .insert(organizations)
    .values({ name: `Test Org ${suffix}`, slug: `test-org-${suffix}` })
    .returning({ id: organizations.id });
  if (!user || !org) throw new Error('seedTestTenant: insert did not return a row');
  const [membership] = await db
    .insert(memberships)
    .values({ organizationId: org.id, userId: user.id, role })
    .returning({ id: memberships.id });
  const [store] = await db
    .insert(stores)
    .values({ organizationId: org.id, shopDomain: `test-${suffix}.myshopify.com` })
    .returning({ id: stores.id });
  if (!store || !membership) throw new Error('seedTestTenant: insert did not return a row');

  return {
    organizationId: org.id,
    storeId: store.id,
    userId: user.id,
    membershipId: membership.id,
    role,
  };
}

/** Deletes a tenant seeded by {@link seedTestTenant}, including its (FK-less) audit_log rows. */
export async function cleanupTestTenant(tenant: TestTenant): Promise<void> {
  await db.delete(auditLog).where(eq(auditLog.organizationId, tenant.organizationId));
  await db.delete(organizations).where(eq(organizations.id, tenant.organizationId)); // cascades: stores, dpa_acceptances, memberships, invites, integrations, ad_accounts, orders, ...
  await db.delete(users).where(eq(users.id, tenant.userId));
}

/** Test-only: flips `stores.child_directed` for a seeded store (no repository method sets it yet). */
export async function setStoreChildDirected(
  storeId: string,
  childDirected: boolean,
): Promise<void> {
  await db.update(stores).set({ childDirected }).where(eq(stores.id, storeId));
}

/** Test-only: records the merchant's India opt-in confirmation (the collector config's second gate). */
export async function confirmIndiaOptIn(storeId: string): Promise<void> {
  await db
    .update(stores)
    .set({ privacyConfig: { checklist: { india_opt_in_confirmed_at: new Date().toISOString() } } })
    .where(eq(stores.id, storeId));
}
