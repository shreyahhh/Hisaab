import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '@truepath/shared';
import { AuditMetadataError, isAuditAction, validateAuditMetadata } from './audit.js';

const UUID = '3f0c9a1e-77aa-4d1b-9c0e-0a1b2c3d4e5f';

function failure(action: string, metadata: unknown): AuditMetadataError {
  try {
    validateAuditMetadata(action, metadata);
  } catch (error) {
    return error as AuditMetadataError;
  }
  throw new Error('expected validateAuditMetadata to throw');
}

describe('validateAuditMetadata', () => {
  it('returns valid metadata parsed, and treats missing metadata as empty', () => {
    expect(validateAuditMetadata('login_failed', { target_user_id: UUID })).toEqual({
      target_user_id: UUID,
    });
    expect(validateAuditMetadata('login_succeeded', undefined)).toEqual({});
    expect(validateAuditMetadata('retention_run', { events: 4, touchpoints: 0 })).toEqual({
      events: 4,
      touchpoints: 0,
    });
  });

  it('rejects an action outside the catalogue', () => {
    expect(isAuditAction('login_failed')).toBe(true);
    expect(isAuditAction('made_up')).toBe(false);
    expect(failure('made_up', {}).reasons).toEqual(['unknown action']);
  });

  it('rejects metadata that does not match the action, naming paths and codes only', () => {
    const error = failure('member_invited', { role: 'someone@example.com' });
    expect(error).toBeInstanceOf(AuditMetadataError);
    expect(error.action).toBe('member_invited');
    expect(error.reasons).toEqual(['role: invalid_enum_value']);
    expect(error.message).not.toContain('someone@example.com');
  });

  it('rejects an email, or a hash, smuggled in as an extra key', () => {
    for (const [key, value] of [
      ['email', 'someone@example.com'],
      ['email_hash', `k1:${'ab'.repeat(32)}`],
      ['attempted', 'someone@example.com'],
    ]) {
      const error = failure('login_failed', { unknown_account: true, [key!]: value });
      expect(error.message).not.toContain('someone@example.com');
      expect(error.message).not.toContain('ab'.repeat(32));
    }
  });

  describe('the PII backstop on free-form maps', () => {
    it('rejects sensitive key names', () => {
      for (const key of [
        'email',
        'phone',
        'ip_address',
        'user_agent',
        'identity_master_k1',
        'password',
      ]) {
        const error = failure('system_scope_used', { [key]: 'x' });
        expect(error.reasons).toContain(`${key}: sensitive key name`);
      }
    });

    it('rejects string values that look like an email, a phone number or a hash', () => {
      for (const [value, kind] of [
        ['someone@example.com', 'email'],
        ['9753124680', 'phone'],
        ['+14155550123', 'phone'],
        [`k1:${'ab'.repeat(32)}`, 'hash'],
        [randomBytes(32).toString('hex'), 'hash'],
      ] as const) {
        const error = failure('system_scope_used', { note: value });
        expect(error.reasons, value).toEqual([`note: looks like ${kind}`]);
        expect(error.message).not.toContain(value);
      }
    });

    it('lets ids, ISO timestamps and plain words through', () => {
      expect(() =>
        validateAuditMetadata('system_scope_used', {
          reason: 'key_rotation',
          store: UUID,
          at: '2026-09-26T10:56:49.614Z',
          attempts: 3,
          dry_run: false,
        }),
      ).not.toThrow();
    });

    it('does not mistake a UUID whose digits resemble a phone number for one', () => {
      expect(() =>
        validateAuditMetadata('system_scope_used', {
          store: '97531246-8012-4345-8675-976431246801',
        }),
      ).not.toThrow();
    });
  });

  it('has a strict schema for every catalogue action except the one free-form map', () => {
    for (const action of AUDIT_ACTIONS.filter((a) => a !== 'system_scope_used')) {
      expect(
        failure(action, { unexpected_key_for_every_action: 'x' }).reasons.length,
      ).toBeGreaterThan(0);
    }
  });
});
