import { randomUUID } from 'node:crypto';
import { createAuditOutboxRepository, createAuditLogRepository } from '@truepath/db';
import type { TenantScope } from '@truepath/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUDIT_OUTBOX_RETENTION_MS,
  AUDIT_OUTBOX_SWEEP_GRACE_MS,
  runAuditOutboxSweep,
  startAuditOutboxSweep,
} from './auditOutboxSweep.js';
import { testDb } from './testApp.js';

// No FK ties audit_log/audit_outbox to a real organization or user (they must outlive either) — a
// fresh random id is a perfectly valid scope for these tests, no tenant/auth seeding needed.
function scope(organizationId = randomUUID()): TenantScope {
  return {
    kind: 'tenant',
    userId: randomUUID(),
    organizationId,
    role: 'job',
    storeIds: new Set(),
  };
}

const outbox = createAuditOutboxRepository(testDb);
const auditLog = createAuditLogRepository(testDb);

function entry(organizationId: string, actorUserId: string) {
  return {
    organizationId,
    actorUserId,
    actorType: 'user' as const,
    action: 'member_role_changed' as const,
    targetType: 'user',
    targetId: actorUserId,
    metadata: { from: 'viewer' as const, to: 'analyst' as const },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe('runAuditOutboxSweep (ADR-0028, issue #13)', () => {
  it('completes a pending row older than the grace period, writing exactly one audit_log row', async () => {
    const s = scope();
    await outbox.enqueue(s, entry(s.organizationId, s.userId!));
    const now = new Date(Date.now() + AUDIT_OUTBOX_SWEEP_GRACE_MS + 1000);

    const result = await runAuditOutboxSweep({ db: testDb, outbox, log: () => {} }, now);

    expect(result.completed).toBeGreaterThanOrEqual(1);
    const { items } = await auditLog.list(s, s.organizationId);
    expect(items).toHaveLength(1);
    expect(items[0]!.action).toBe('member_role_changed');
  });

  it('leaves a row younger than the grace period alone', async () => {
    const s = scope();
    await outbox.enqueue(s, entry(s.organizationId, s.userId!));
    const now = new Date(); // no time has passed — well inside the grace period

    await runAuditOutboxSweep({ db: testDb, outbox, log: () => {} }, now);

    expect((await auditLog.list(s, s.organizationId)).items).toEqual([]);
  });

  it('a row already completed by the normal path is left alone (no duplicate audit_log row)', async () => {
    const s = scope();
    const outboxId = await outbox.enqueue(s, entry(s.organizationId, s.userId!));
    await outbox.complete(outboxId);
    const now = new Date(Date.now() + AUDIT_OUTBOX_SWEEP_GRACE_MS + 1000);

    await runAuditOutboxSweep({ db: testDb, outbox, log: () => {} }, now);

    expect((await auditLog.list(s, s.organizationId)).items).toHaveLength(1);
  });

  // `deleteFinished` itself has no per-run id restriction (by design: production sweeps every
  // eligible row) — exercising the real thing here would delete other tests' done rows in this
  // shared database. The repository's own test (auditOutboxRepository.test.ts) already proves
  // `deleteFinished`'s behaviour with a scoped set of ids; this just proves the sweep *calls* it
  // with the right cutoff and reports its count.
  it('calls deleteFinished with a cutoff at the retention window, and reports its count', async () => {
    let received: { olderThan: Date } | undefined;
    const spiedOutbox = {
      ...outbox,
      deleteFinished: async (scopeArg: TenantScope, olderThan: Date) => {
        received = { olderThan };
        void scopeArg;
        return { deleted: 3 };
      },
    };
    const now = new Date(Date.now() + AUDIT_OUTBOX_RETENTION_MS + 1000);

    const result = await runAuditOutboxSweep(
      { db: testDb, outbox: spiedOutbox, log: () => {} },
      now,
    );

    expect(result.deleted).toBe(3);
    expect(received?.olderThan.getTime()).toBe(now.getTime() - AUDIT_OUTBOX_RETENTION_MS);
  });

  it('a persistently failing row is reported but does not stop the sweep from finishing the others', async () => {
    const s = scope();
    const bad = await outbox.enqueue(s, entry(s.organizationId, s.userId!));
    await outbox.enqueue(s, entry(s.organizationId, s.userId!));
    const brokenOutbox = {
      ...outbox,
      complete: async (id: string) => {
        if (id === bad) throw new Error('db is down');
        return outbox.complete(id);
      },
    };
    const logLines: Record<string, unknown>[] = [];
    const now = new Date(Date.now() + AUDIT_OUTBOX_SWEEP_GRACE_MS + 1000);

    const result = await runAuditOutboxSweep(
      { db: testDb, outbox: brokenOutbox, log: (l) => logLines.push(l) },
      now,
    );

    expect(result.completed).toBe(1);
    expect(result.stillFailing).toBe(1);
    expect(logLines.some((l) => l['event'] === 'audit_outbox_sweep_complete_failed')).toBe(true);
    // The good row still made it to audit_log despite the bad one failing alongside it.
    expect((await auditLog.list(s, s.organizationId)).items).toHaveLength(1);
  });
});

describe('startAuditOutboxSweep', () => {
  it('runs on the interval, and never overlaps an in-flight sweep', async () => {
    // Real timers throughout: the sweep does real DB I/O, which doesn't mix well with faked ones.
    let running = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const slowOutbox = {
      ...outbox,
      listPending: async (...args: Parameters<typeof outbox.listPending>) => {
        calls += 1;
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((resolve) => setTimeout(resolve, 30));
        running -= 1;
        return outbox.listPending(...args);
      },
    };

    // A 10ms interval against a 30ms sweep: several ticks fire while one is still in flight.
    const stop = startAuditOutboxSweep({ db: testDb, outbox: slowOutbox, log: () => {} }, 10);
    cleanups.push(stop);
    await new Promise((resolve) => setTimeout(resolve, 100));
    stop();

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(maxConcurrent).toBe(1);
  });
});
