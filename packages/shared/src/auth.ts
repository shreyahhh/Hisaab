import { z } from 'zod';

// RBAC roles, permissions, and the TenantScope/SystemScope primitives every route handler,
// repository method and ClickHouse query goes through (auth-tenancy.md §2.3/§2.4, ADR-0016).
// `Role` is fully code-controlled (the permission matrix below is its only consumer), so
// packages/db's schema uses a native pgEnum built from ROLES rather than the text+CHECK pattern
// in valueLists.ts (see packages/db/src/schema/enums.ts's own comment on that distinction).

// Declaration order here is also the Postgres enum's value order (packages/db/src/schema/enums.ts
// roleEnum) — reordering it means a new migration recreating the type, so ROLE_RANK below is a
// separate, explicit map instead of ROLES.indexOf(), and can be changed freely without touching
// the database.
export const ROLES = ['owner', 'admin', 'analyst', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const RoleSchema = z.enum(ROLES);

// Lowest → highest privilege (auth-tenancy.md §2.4's hierarchy: viewer < analyst < admin < owner).
const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 0, analyst: 1, admin: 2, owner: 3 };

/** A role's rank in the hierarchy (higher = more privileged). */
export function roleRank(role: Role): number {
  return ROLE_RANK[role];
}

/** Whether `targetRole` is at or below `actorRole`'s own rank (never strictly above it). */
export function isAtOrBelowOwnRank(actorRole: Role, targetRole: Role): boolean {
  return roleRank(targetRole) <= roleRank(actorRole);
}

export const PERMISSIONS = [
  'reports.read',
  'reports.export',
  'journey.read',
  'settings.attribution.write',
  'settings.channel_rules.write',
  'integrations.manage',
  'integrations.settings.write',
  'privacy.requests',
  'privacy.export.download',
  'privacy.settings.write',
  'audit.read',
  'team.manage',
  'dpa.accept',
  'org.delete',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// auth-tenancy.md §2.4 permission matrix. A permission not listed for a role is denied.
const PERMISSION_MATRIX: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  owner: new Set(PERMISSIONS),
  admin: new Set(PERMISSIONS.filter((p) => p !== 'dpa.accept' && p !== 'org.delete')),
  analyst: new Set(['reports.read', 'reports.export', 'journey.read']),
  viewer: new Set(['reports.read']),
};

export interface TenantScope {
  readonly kind: 'tenant';
  readonly userId: string | null;
  readonly organizationId: string;
  // 'job' identifies a scope built for a background job (TenantScope.forJob in packages/db) that
  // acts on a store on behalf of the system, not a signed-in user with an RBAC role. It never goes
  // through a route's permission check (can() is only ever called with a real Role) — the
  // repository/query-builder store_id membership assertion is what protects it.
  readonly role: Role | 'job';
  readonly storeIds: ReadonlySet<string>;
}

// auth-tenancy.md §2.3. Cross-tenant jobs (retention, reconcile fan-out, suppression rehydration,
// key rotation, breach admin, scheduler fan-out, org deletion) construct this explicitly via
// packages/db's `createSystemScope`, which audits every use (ADR-0016).
export const SYSTEM_REASONS = [
  'retention',
  'order_status_reconcile',
  'suppression_rebuild',
  'attribution_nightly',
  'shopify_reconcile',
  'key_rotation',
  'breach_admin',
  'scheduler_fanout',
  'org_deletion',
] as const;
export type SystemReason = (typeof SYSTEM_REASONS)[number];

export interface SystemScope {
  readonly kind: 'system';
  readonly reason: SystemReason;
  readonly auditId: string;
}

export type Scope = TenantScope | SystemScope;

/**
 * RBAC permission check for a signed-in user's TenantScope (auth-tenancy.md §2.3). Not applicable
 * to SystemScope — system-scoped code is authorised by construction (createSystemScope) and by
 * the repository/query-builder membership assertion, not by this permission matrix.
 */
export function can(scope: TenantScope, permission: Permission): boolean {
  if (scope.role === 'job') return true;
  return roleCan(scope.role, permission);
}

/** Whether a role — not a whole scope — holds a permission (e.g. an inviter's role at invite-accept time). */
export function roleCan(role: Role, permission: Permission): boolean {
  return PERMISSION_MATRIX[role].has(permission);
}

// Thrown by the scoped repository layer (packages/db) and the ClickHouse query builder
// (packages/clickhouse) whenever a caller's scope doesn't cover the store/organization it asked
// for. Routes turn this into a 404 (auth-tenancy.md §4.3/§5.10 test 7); it must never leak which
// resource actually exists.
export class TenantScopeViolationError extends Error {
  constructor(resourceKind: 'store' | 'organization', resourceId: string) {
    super(`Scope does not cover ${resourceKind} ${resourceId}`);
    this.name = 'TenantScopeViolationError';
  }
}

/** Throws {@link TenantScopeViolationError} unless `scope` is a SystemScope or covers `storeId`. */
export function assertStoreInScope(scope: Scope, storeId: string): void {
  if (scope.kind === 'system') return;
  if (!scope.storeIds.has(storeId)) {
    throw new TenantScopeViolationError('store', storeId);
  }
}

/** Throws {@link TenantScopeViolationError} unless `scope` is a SystemScope or is `organizationId`. */
export function assertOrganizationInScope(scope: Scope, organizationId: string): void {
  if (scope.kind === 'system') return;
  if (scope.organizationId !== organizationId) {
    throw new TenantScopeViolationError('organization', organizationId);
  }
}
