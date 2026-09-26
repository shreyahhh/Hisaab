import { eq } from 'drizzle-orm';
import { AuditMetadataError } from '@truepath/privacy';
import { describe, expect, it } from 'vitest';
import { createSystemScope } from './systemScope.js';
import { auditLog } from './schema/index.js';
import { cleanupTestTenant, db, seedTestTenant } from './testing.js';

describe('createSystemScope (ADR-0016 §4.4 — the only SystemScope constructor)', () => {
  it('writes a system_scope_used audit_log row and returns a scope carrying its id', async () => {
    const tenant = await seedTestTenant('sysscope');
    try {
      const scope = await createSystemScope(db, 'retention', {
        organizationId: tenant.organizationId,
        metadata: { note: 'test' },
      });
      expect(scope).toEqual({ kind: 'system', reason: 'retention', auditId: scope.auditId });

      const [row] = await db.select().from(auditLog).where(eq(auditLog.id, scope.auditId));
      expect(row?.actorType).toBe('system');
      expect(row?.action).toBe('system_scope_used');
      expect(row?.organizationId).toBe(tenant.organizationId);
      expect(row?.targetId).toBe('retention');
      expect(row?.metadata).toEqual({ note: 'test' });
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('allows organizationId to be omitted for platform-wide system scopes', async () => {
    const scope = await createSystemScope(db, 'suppression_rebuild');
    try {
      const [row] = await db.select().from(auditLog).where(eq(auditLog.id, scope.auditId));
      expect(row?.organizationId).toBeNull();
    } finally {
      await db.delete(auditLog).where(eq(auditLog.id, scope.auditId));
    }
  });

  it('rejects metadata that is not flat scalars or looks like personal data, and writes no row', async () => {
    const since = new Date();
    await expect(
      createSystemScope(db, 'retention', { metadata: { email: 'someone@example.com' } }),
    ).rejects.toThrow(AuditMetadataError);
    await expect(
      createSystemScope(db, 'retention', { metadata: { note: 'someone@example.com' } }),
    ).rejects.toThrow(AuditMetadataError);
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'system_scope_used'));
    expect(rows.filter((r) => r.createdAt >= since && r.targetId === 'retention')).toEqual([]);
  });
});
