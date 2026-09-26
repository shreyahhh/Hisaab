import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AUDIT_ACTION_OWNERS,
  AUDIT_METADATA_SCHEMAS,
  isPlatformAuditAction,
  PLATFORM_AUDIT_ACTIONS,
  type AuditEntryInput,
  type OrganizationAuditEntry,
  type PlatformAuditEntry,
} from './audit.js';
import { AUDIT_ACTIONS } from './valueLists.js';

const UUID = '3f0c9a1e-77aa-4d1b-9c0e-0a1b2c3d4e5f';

describe('audit metadata schemas', () => {
  it('has exactly one schema and one owner for every action in the catalogue', () => {
    expect(Object.keys(AUDIT_METADATA_SCHEMAS).sort()).toEqual([...AUDIT_ACTIONS].sort());
    expect(Object.keys(AUDIT_ACTION_OWNERS).sort()).toEqual([...AUDIT_ACTIONS].sort());
  });

  it.each([
    ['login_succeeded', {}],
    ['login_failed', { target_user_id: UUID }],
    ['login_failed', { unknown_account: true }],
    ['member_invited', { role: 'admin' }],
    ['member_role_changed', { from: 'viewer', to: 'analyst' }],
    ['member_removed', { role: 'viewer', self: true }],
    ['dpa_accepted', { dpa_version: '2026-09' }],
    ['privacy_settings_changed', { changed_fields: 'retention_months,child_directed' }],
    ['dsr_created', { type: 'erasure', trigger: 'merchant' }],
    ['retention_run', { events: 12, touchpoints: 3 }],
    ['system_scope_used', { note: 'test', attempt: 1 }],
  ] as const)('accepts %s with %j', (action, metadata) => {
    expect(AUDIT_METADATA_SCHEMAS[action].safeParse(metadata).success).toBe(true);
  });

  it.each([
    ['login_failed', { email: 'someone@example.com' }],
    ['login_failed', { target_user_id: UUID, unknown_account: true }],
    ['login_failed', { target_user_id: 'someone@example.com' }],
    ['login_failed', {}],
    ['login_failed', { unknown_account: false }],
    ['login_succeeded', { email: 'x' }],
    ['member_invited', { role: 'superuser' }],
    ['member_invited', { role: 'admin', email: 'a@example.com' }],
    ['member_removed', { role: 'viewer', self: 'yes' }],
    ['privacy_settings_changed', { changed_fields: 'retention_months=3' }],
    ['dsr_created', { type: 'erasure', trigger: 'merchant', identity_hash: 'k1:ab' }],
    ['retention_run', { events: 'many' }],
    ['retention_run', { Events: 1 }],
    ['system_scope_used', { nested: { a: 1 } }],
    ['org_deleted', { stores: -1 }],
  ] as const)('rejects %s with %j', (action, metadata) => {
    expect(AUDIT_METADATA_SCHEMAS[action].safeParse(metadata).success).toBe(false);
  });

  it('only allows flat scalar metadata: no schema accepts a nested object or an array value', () => {
    for (const action of AUDIT_ACTIONS) {
      const schema = AUDIT_METADATA_SCHEMAS[action];
      expect(schema.safeParse({ role: { nested: true } }).success, action).toBe(false);
      expect(schema.safeParse({ items: [1, 2] }).success, action).toBe(false);
    }
  });
});

describe('platform actions', () => {
  it('are a subset of the catalogue and detected at runtime', () => {
    for (const action of PLATFORM_AUDIT_ACTIONS) {
      expect(AUDIT_ACTIONS).toContain(action);
      expect(isPlatformAuditAction(action)).toBe(true);
    }
    for (const action of ['member_invited', 'dsr_created', 'system_scope_used', 'nope']) {
      expect(isPlatformAuditAction(action)).toBe(false);
    }
  });
});

describe('audit entry types (compile-time)', () => {
  it('ties metadata to the action', () => {
    const ok: AuditEntryInput = {
      action: 'member_role_changed',
      actorType: 'user',
      targetType: 'user',
      targetId: UUID,
      metadata: { from: 'viewer', to: 'analyst' },
    };
    expect(ok.action).toBe('member_role_changed');

    // @ts-expect-error metadata is required for member_role_changed
    const missing: AuditEntryInput = {
      action: 'member_role_changed',
      actorType: 'user',
      targetType: 'user',
      targetId: UUID,
    };
    const wrongShape: AuditEntryInput = {
      action: 'member_role_changed',
      actorType: 'user',
      targetType: 'user',
      targetId: UUID,
      // @ts-expect-error `email` is not part of this action's metadata
      metadata: { from: 'viewer', to: 'analyst', email: 'a@example.com' },
    };
    const optional: AuditEntryInput = {
      action: 'login_succeeded',
      actorType: 'user',
      targetType: 'auth',
      targetId: 'login',
    };
    expect([missing, wrongShape, optional]).toHaveLength(3);
  });

  it('limits platform entries to the platform actions', () => {
    const ok: PlatformAuditEntry = {
      action: 'login_failed',
      actorType: 'user',
      targetType: 'auth',
      targetId: 'login',
      metadata: { unknown_account: true },
    };
    const notPlatform: PlatformAuditEntry = {
      // @ts-expect-error member_invited is not a platform action
      action: 'member_invited',
      actorType: 'user',
      targetType: 'invite',
      targetId: UUID,
      metadata: { role: 'admin' },
    };
    expect([ok, notPlatform]).toHaveLength(2);
    expectTypeOf<PlatformAuditEntry['action']>().toEqualTypeOf<
      (typeof PLATFORM_AUDIT_ACTIONS)[number]
    >();
  });

  it('keeps platform actions out of organization entries', () => {
    const platformWithOrg: OrganizationAuditEntry = {
      organizationId: UUID,
      // @ts-expect-error login_succeeded has no organization: use writePlatform
      action: 'login_succeeded',
      actorType: 'user',
      targetType: 'auth',
      targetId: 'login',
    };
    expect(platformWithOrg).toBeDefined();
  });

  it('requires an organization on organization entries', () => {
    // @ts-expect-error organizationId is required
    const noOrg: OrganizationAuditEntry = {
      action: 'member_invite_accepted',
      actorType: 'user',
      targetType: 'auth',
      targetId: 'login',
    };
    expect(noOrg).toBeDefined();
  });
});
