import { describe, expect, it } from 'vitest';
import {
  ROLES,
  RoleSchema,
  PERMISSIONS,
  can,
  roleRank,
  isAtOrBelowOwnRank,
  assertStoreInScope,
  assertOrganizationInScope,
  TenantScopeViolationError,
  type TenantScope,
  type SystemScope,
} from './auth.js';

function tenantScope(overrides: Partial<TenantScope> = {}): TenantScope {
  return {
    kind: 'tenant',
    userId: 'user-a',
    organizationId: 'org-a',
    role: 'viewer',
    storeIds: new Set(['store-a']),
    ...overrides,
  };
}

const systemScope: SystemScope = { kind: 'system', reason: 'retention', auditId: 'audit-1' };

describe('can() — auth-tenancy.md §2.4 permission matrix', () => {
  it('grants owner every permission', () => {
    const scope = tenantScope({ role: 'owner' });
    for (const p of PERMISSIONS) expect(can(scope, p)).toBe(true);
  });

  it('denies admin dpa.accept and org.delete (owner-only)', () => {
    const scope = tenantScope({ role: 'admin' });
    expect(can(scope, 'dpa.accept')).toBe(false);
    expect(can(scope, 'org.delete')).toBe(false);
    expect(can(scope, 'team.manage')).toBe(true);
    expect(can(scope, 'integrations.manage')).toBe(true);
  });

  it('limits analyst to reports/journey read+export, nothing else', () => {
    const scope = tenantScope({ role: 'analyst' });
    expect(can(scope, 'reports.read')).toBe(true);
    expect(can(scope, 'reports.export')).toBe(true);
    expect(can(scope, 'journey.read')).toBe(true);
    expect(can(scope, 'settings.attribution.write')).toBe(false);
    expect(can(scope, 'audit.read')).toBe(false);
  });

  it('limits viewer to reports.read only', () => {
    const scope = tenantScope({ role: 'viewer' });
    expect(can(scope, 'reports.read')).toBe(true);
    expect(can(scope, 'reports.export')).toBe(false);
    expect(can(scope, 'journey.read')).toBe(false);
  });

  it('a job-scoped TenantScope bypasses the permission matrix (not RBAC-gated)', () => {
    const scope = tenantScope({ role: 'job' });
    for (const p of PERMISSIONS) expect(can(scope, p)).toBe(true);
  });

  it('every role is covered by ROLES and RoleSchema stays in sync', () => {
    expect([...RoleSchema.options]).toEqual([...ROLES]);
  });
});

describe('assertStoreInScope / assertOrganizationInScope (ADR-0016)', () => {
  it('passes a TenantScope that covers the store/org', () => {
    const scope = tenantScope();
    expect(() => assertStoreInScope(scope, 'store-a')).not.toThrow();
    expect(() => assertOrganizationInScope(scope, 'org-a')).not.toThrow();
  });

  it('throws TenantScopeViolationError for a store/org outside the TenantScope', () => {
    const scope = tenantScope();
    expect(() => assertStoreInScope(scope, 'store-b')).toThrow(TenantScopeViolationError);
    expect(() => assertOrganizationInScope(scope, 'org-b')).toThrow(TenantScopeViolationError);
  });

  it('never throws for a SystemScope, regardless of id', () => {
    expect(() => assertStoreInScope(systemScope, 'store-anything')).not.toThrow();
    expect(() => assertOrganizationInScope(systemScope, 'org-anything')).not.toThrow();
  });
});

describe('roleRank / isAtOrBelowOwnRank (auth-tenancy.md §2.4 hierarchy)', () => {
  it('ranks viewer < analyst < admin < owner', () => {
    expect(roleRank('viewer')).toBeLessThan(roleRank('analyst'));
    expect(roleRank('analyst')).toBeLessThan(roleRank('admin'));
    expect(roleRank('admin')).toBeLessThan(roleRank('owner'));
  });

  it("allows granting a role at or below the actor's own rank", () => {
    expect(isAtOrBelowOwnRank('admin', 'admin')).toBe(true);
    expect(isAtOrBelowOwnRank('admin', 'analyst')).toBe(true);
    expect(isAtOrBelowOwnRank('admin', 'viewer')).toBe(true);
    expect(isAtOrBelowOwnRank('owner', 'owner')).toBe(true);
  });

  it("denies granting a role above the actor's own rank", () => {
    expect(isAtOrBelowOwnRank('admin', 'owner')).toBe(false);
    expect(isAtOrBelowOwnRank('analyst', 'admin')).toBe(false);
    expect(isAtOrBelowOwnRank('viewer', 'analyst')).toBe(false);
  });
});
