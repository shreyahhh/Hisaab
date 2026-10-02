import { TenantScopeViolationError, type SystemScope, type TenantScope } from '@truepath/shared';
import { AuditMetadataError } from '@truepath/privacy';
import { describe, expect, it } from 'vitest';
import { createAuditOutboxRepository } from './auditOutboxRepository.js';
import { createAuditLogRepository } from './auditLogRepository.js';
import { SystemScopeRequiredError } from './suppressionRebuildRepository.js';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '../testing.js';

const system: SystemScope = { kind: 'system', reason: 'suppression_rebuild', auditId: 'test' };

function ownerScope(t: TestTenant): TenantScope {
  return {
    kind: 'tenant',
    userId: t.userId,
    organizationId: t.organizationId,
    role: 'owner',
    storeIds: new Set([t.storeId]),
  };
}

async function withTenant<T>(label: string, run: (t: TestTenant) => Promise<T>): Promise<T> {
  const tenant = await seedTestTenant(label);
  try {
    return await run(tenant);
  } finally {
    await cleanupTestTenant(tenant);
  }
}

// The types already forbid these; the writer must refuse them at runtime for callers that got past the compiler.
const bypassTypes = (entry: unknown) => entry as never;

const roleChanged = (organizationId: string, actorUserId: string, targetId: string) =>
  ({
    organizationId,
    actorUserId,
    actorType: 'user' as const,
    action: 'member_role_changed' as const,
    targetType: 'user',
    targetId,
    metadata: { from: 'viewer' as const, to: 'analyst' as const },
  }) as const;

describe('AuditOutboxRepository (ADR-0028, issue #13)', () => {
  it('enqueue -> complete writes exactly one audit_log row and marks the outbox row done', async () => {
    await withTenant('audit-outbox-happy', async (tenant) => {
      const outbox = createAuditOutboxRepository(db);
      const auditLog = createAuditLogRepository(db);
      const scope = ownerScope(tenant);
      const entry = roleChanged(tenant.organizationId, tenant.userId, tenant.userId);

      const outboxId = await outbox.enqueue(scope, entry);
      const auditLogId = await outbox.complete(outboxId);

      expect(auditLogId).not.toBeNull();
      const { items } = await auditLog.list(scope, tenant.organizationId);
      expect(items).toHaveLength(1);
      expect(items[0]!.id).toBe(auditLogId);
      expect(items[0]!).toMatchObject({ action: 'member_role_changed', metadata: entry.metadata });
    });
  });

  it('a second complete() call is a no-op and returns the same audit_log id (idempotent)', async () => {
    await withTenant('audit-outbox-idempotent', async (tenant) => {
      const outbox = createAuditOutboxRepository(db);
      const auditLog = createAuditLogRepository(db);
      const scope = ownerScope(tenant);
      const outboxId = await outbox.enqueue(
        scope,
        roleChanged(tenant.organizationId, tenant.userId, tenant.userId),
      );

      const first = await outbox.complete(outboxId);
      const second = await outbox.complete(outboxId);

      expect(second).toBe(first);
      expect((await auditLog.list(scope, tenant.organizationId)).items).toHaveLength(1);
    });
  });

  it('complete() on an unknown id is a no-op, returning null', async () => {
    const outbox = createAuditOutboxRepository(db);
    expect(await outbox.complete('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('enqueue refuses an entry outside the caller scope (ADR-0016)', async () => {
    await withTenant('audit-outbox-foreign', async (tenant) => {
      const outbox = createAuditOutboxRepository(db);
      const scope = ownerScope(tenant);
      await expect(
        outbox.enqueue(
          scope,
          roleChanged('00000000-0000-0000-0000-000000000000', tenant.userId, tenant.userId),
        ),
      ).rejects.toThrow(TenantScopeViolationError);
    });
  });

  it('a metadata validation failure marks the row abandoned and rethrows, not retried', async () => {
    await withTenant('audit-outbox-invalid', async (tenant) => {
      const outbox = createAuditOutboxRepository(db);
      const auditLog = createAuditLogRepository(db);
      const scope = ownerScope(tenant);
      const outboxId = await outbox.enqueue(
        scope,
        bypassTypes({
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          actorType: 'user',
          action: 'member_invited',
          targetType: 'invite',
          targetId: 'x',
          metadata: { role: 'not-a-real-role' },
        }),
      );

      await expect(outbox.complete(outboxId)).rejects.toThrow(AuditMetadataError);
      // Not retried: a second attempt is a no-op, same as the "already completed" case, and nothing
      // was ever written to audit_log.
      expect(await outbox.complete(outboxId)).toBeNull();
      expect((await auditLog.list(scope, tenant.organizationId)).items).toEqual([]);
    });
  });

  it('enqueuePlatform records a platform-wide entry (no organization) and completes it', async () => {
    const outbox = createAuditOutboxRepository(db);
    const outboxId = await outbox.enqueuePlatform({
      actorType: 'user',
      action: 'login_succeeded',
      targetType: 'auth',
      targetId: 'login',
    });

    const auditLogId = await outbox.complete(outboxId);
    expect(auditLogId).not.toBeNull();
  });

  describe('listPending / deleteFinished (SystemScope only)', () => {
    it('refuses a TenantScope', async () => {
      await withTenant('audit-outbox-scope', async (tenant) => {
        const outbox = createAuditOutboxRepository(db);
        const scope = ownerScope(tenant);
        await expect(outbox.listPending(scope, new Date())).rejects.toThrow(
          SystemScopeRequiredError,
        );
        await expect(outbox.deleteFinished(scope, new Date())).rejects.toThrow(
          SystemScopeRequiredError,
        );
      });
    });

    // Cross-tenant by nature: filter to this test's own ids so another concurrent test's rows never
    // make this test flaky (same caution as metaWarmupSchedulingRepository.test.ts).
    it('lists only pending rows older than the cutoff, oldest first', async () => {
      await withTenant('audit-outbox-list-pending', async (tenant) => {
        const outbox = createAuditOutboxRepository(db);
        const scope = ownerScope(tenant);

        const older = await outbox.enqueue(
          scope,
          roleChanged(tenant.organizationId, tenant.userId, 'a'),
        );
        const newer = await outbox.enqueue(
          scope,
          roleChanged(tenant.organizationId, tenant.userId, 'b'),
        );
        const completed = await outbox.enqueue(
          scope,
          roleChanged(tenant.organizationId, tenant.userId, 'c'),
        );
        await outbox.complete(completed);

        const cutoff = new Date(Date.now() + 1000);
        const pending = (
          await outbox.listPending(system, cutoff, { outboxIds: [older, newer, completed] })
        ).map((r) => r.id);
        expect(pending).toEqual([older, newer]);
      });
    });

    it('deleteFinished removes done and abandoned rows older than the cutoff, leaves pending ones', async () => {
      await withTenant('audit-outbox-delete-finished', async (tenant) => {
        const outbox = createAuditOutboxRepository(db);
        const scope = ownerScope(tenant);

        const done = await outbox.enqueue(
          scope,
          roleChanged(tenant.organizationId, tenant.userId, 'a'),
        );
        await outbox.complete(done);
        const stillPending = await outbox.enqueue(
          scope,
          roleChanged(tenant.organizationId, tenant.userId, 'b'),
        );

        const cutoff = new Date(Date.now() + 1000);
        const { deleted } = await outbox.deleteFinished(system, cutoff, [done]);
        expect(deleted).toBe(1);
        const remaining = (
          await outbox.listPending(system, cutoff, { outboxIds: [stillPending] })
        ).map((r) => r.id);
        expect(remaining).toEqual([stillPending]);
      });
    });
  });
});
