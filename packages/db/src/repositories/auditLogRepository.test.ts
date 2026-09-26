import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { TenantScopeViolationError, type TenantScope } from '@truepath/shared';
import { AuditMetadataError } from '@truepath/privacy';
import { describe, expect, it } from 'vitest';
import {
  createAuditLogRepository,
  InvalidAuditCursorError,
  MAX_AUDIT_PAGE_SIZE,
} from './auditLogRepository.js';
import { auditLog } from '../schema/index.js';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '../testing.js';

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

// The types already forbid these entries; the writer must refuse them at runtime too, for callers that got past the compiler.
const bypassTypes = (entry: unknown) => entry as never;

const viewed = (organizationId: string, actorUserId?: string) =>
  ({
    organizationId,
    actorUserId: actorUserId ?? null,
    actorType: 'user',
    action: 'audit_log_viewed',
    targetType: 'organization',
    targetId: organizationId,
  }) as const;

describe('AuditLogRepository.write / list (ADR-0016, SPEC S-4)', () => {
  it('writes an entry for the organization in scope and lists it', async () => {
    await withTenant('audit-repo', async (tenant) => {
      const repo = createAuditLogRepository(db);
      const scope = ownerScope(tenant);
      await repo.write(scope, {
        organizationId: tenant.organizationId,
        actorUserId: tenant.userId,
        actorType: 'user',
        action: 'member_role_changed',
        targetType: 'user',
        targetId: tenant.userId,
        metadata: { from: 'viewer', to: 'analyst' },
      });

      const { items, nextCursor } = await repo.list(scope, tenant.organizationId);
      expect(nextCursor).toBeNull();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        action: 'member_role_changed',
        organizationId: tenant.organizationId,
        actorUserId: tenant.userId,
        metadata: { from: 'viewer', to: 'analyst' },
      });
    });
  });

  it('denies write and list for an organization outside scope (SPEC §5.10 test 7)', async () => {
    const tenantA = await seedTestTenant('audit-repo-a');
    const tenantB = await seedTestTenant('audit-repo-b');
    try {
      const repo = createAuditLogRepository(db);
      const scopeA = ownerScope(tenantA);
      await expect(repo.write(scopeA, viewed(tenantB.organizationId))).rejects.toThrow(
        TenantScopeViolationError,
      );
      await expect(repo.list(scopeA, tenantB.organizationId)).rejects.toThrow(
        TenantScopeViolationError,
      );
    } finally {
      await cleanupTestTenant(tenantA);
      await cleanupTestTenant(tenantB);
    }
  });

  it("never lists another organization's rows", async () => {
    const tenantA = await seedTestTenant('audit-iso-a');
    const tenantB = await seedTestTenant('audit-iso-b');
    try {
      const repo = createAuditLogRepository(db);
      await repo.write(ownerScope(tenantA), viewed(tenantA.organizationId));
      await repo.write(ownerScope(tenantB), viewed(tenantB.organizationId));
      const { items } = await repo.list(ownerScope(tenantA), tenantA.organizationId);
      expect(items.map((r) => r.organizationId)).toEqual([tenantA.organizationId]);
    } finally {
      await cleanupTestTenant(tenantA);
      await cleanupTestTenant(tenantB);
    }
  });

  it('writePlatform writes an organization-less entry, with no scope', async () => {
    // Found by a unique id: other suites write login_failed rows to the same table at the same time.
    const targetUserId = randomUUID();
    await createAuditLogRepository(db).writePlatform({
      action: 'login_failed',
      actorType: 'user',
      targetType: 'auth',
      targetId: 'login',
      metadata: { target_user_id: targetUserId },
    });
    const mine = sql`${auditLog.metadata}->>'target_user_id' = ${targetUserId}`;
    try {
      const rows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'login_failed'), mine));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.organizationId).toBeNull();
    } finally {
      await db.delete(auditLog).where(and(eq(auditLog.action, 'login_failed'), mine));
    }
  });

  it('keeps platform actions and organizations apart at runtime, not only in the types', async () => {
    await withTenant('audit-platform-split', async (tenant) => {
      const repo = createAuditLogRepository(db);
      await expect(
        repo.writePlatform(
          bypassTypes({
            action: 'member_invited',
            actorType: 'user',
            targetType: 'invite',
            targetId: 'x',
            metadata: { role: 'viewer' },
          }),
        ),
      ).rejects.toThrow(/not a platform audit action/);
      await expect(
        repo.write(
          ownerScope(tenant),
          bypassTypes({
            organizationId: tenant.organizationId,
            action: 'login_succeeded',
            actorType: 'user',
            targetType: 'auth',
            targetId: 'login',
          }),
        ),
      ).rejects.toThrow(/use writePlatform/);
    });
  });

  it('rejects metadata that does not match the action, and writes nothing', async () => {
    await withTenant('audit-metadata', async (tenant) => {
      const repo = createAuditLogRepository(db);
      const scope = ownerScope(tenant);
      await expect(
        repo.write(
          scope,
          bypassTypes({
            ...viewed(tenant.organizationId),
            metadata: { email: 'someone@example.com' },
          }),
        ),
      ).rejects.toThrow(AuditMetadataError);
      await expect(
        repo.write(
          scope,
          bypassTypes({
            organizationId: tenant.organizationId,
            actorType: 'user',
            action: 'member_invited',
            targetType: 'invite',
            targetId: 'x',
            metadata: { role: 'someone@example.com' },
          }),
        ),
      ).rejects.toThrow(AuditMetadataError);
      expect((await repo.list(scope, tenant.organizationId)).items).toEqual([]);
    });
  });

  it('exposes no way to update or delete a row', () => {
    expect(Object.keys(createAuditLogRepository(db)).sort()).toEqual([
      'list',
      'write',
      'writePlatform',
    ]);
  });

  it('commits with a surrounding transaction, or not at all', async () => {
    await withTenant('audit-tx', async (tenant) => {
      const scope = ownerScope(tenant);
      await expect(
        db.transaction(async (tx) => {
          await createAuditLogRepository(tx).write(scope, viewed(tenant.organizationId));
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      expect((await createAuditLogRepository(db).list(scope, tenant.organizationId)).items).toEqual(
        [],
      );

      await db.transaction(async (tx) => {
        await createAuditLogRepository(tx).write(scope, viewed(tenant.organizationId));
      });
      expect(
        (await createAuditLogRepository(db).list(scope, tenant.organizationId)).items,
      ).toHaveLength(1);
    });
  });
});

describe('AuditLogRepository.list: filters, ordering and cursor pagination', () => {
  // Microsecond timestamps chosen so several rows tie exactly and others differ only below the
  // millisecond, which a JS Date cannot express: the cursor must still page through them exactly once.
  async function seedRows(tenant: TestTenant) {
    const stamps = [
      '2026-01-01T00:00:03.123456Z',
      '2026-01-01T00:00:03.123456Z',
      '2026-01-01T00:00:03.123456Z',
      '2026-01-01T00:00:03.123123Z',
      '2026-01-01T00:00:03.123999Z',
      '2026-01-01T00:00:02.000000Z',
      '2026-01-01T00:00:01.000000Z',
    ];
    for (const [i, stamp] of stamps.entries()) {
      await db.insert(auditLog).values({
        organizationId: tenant.organizationId,
        actorType: 'user',
        action: i === 6 ? 'member_removed' : 'audit_log_viewed',
        targetType: 'organization',
        targetId: `row-${i}`,
        metadata: i === 6 ? { role: 'viewer', self: false } : {},
        createdAt: sql`${stamp}::timestamptz`,
      });
    }
    return stamps.length;
  }

  it('returns newest first and pages through every row exactly once, whatever the page size', async () => {
    await withTenant('audit-page', async (tenant) => {
      const total = await seedRows(tenant);
      const expected = (
        await db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(eq(auditLog.organizationId, tenant.organizationId))
          .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      ).map((r) => r.id);
      expect(expected).toHaveLength(total);

      const repo = createAuditLogRepository(db);
      const scope = ownerScope(tenant);
      for (const limit of [1, 2, 3, 4, total, total + 5]) {
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await repo.list(scope, tenant.organizationId, {
            limit,
            ...(cursor ? { cursor } : {}),
          });
          seen.push(...page.items.map((r) => r.id));
          cursor = page.nextCursor ?? undefined;
          pages += 1;
          expect(pages).toBeLessThanOrEqual(total + 1);
        } while (cursor);
        expect(seen, `limit ${limit}`).toEqual(expected);
      }
    });
  });

  it("takes the organization from the scope only: another organization's cursor reads the caller's own log", async () => {
    const tenantA = await seedTestTenant('audit-cursor-a');
    const tenantB = await seedTestTenant('audit-cursor-b');
    try {
      await seedRows(tenantA);
      const repo = createAuditLogRepository(db);
      const fromA = await repo.list(ownerScope(tenantA), tenantA.organizationId, { limit: 2 });
      expect(fromA.nextCursor).not.toBeNull();

      // A's first page ends at 03.123456: B's rows newer than that must not appear.
      const bRows = [
        ['2026-01-01T00:00:04.000000Z', 'newer'],
        ['2026-01-01T00:00:03.450000Z', 'newer-too'],
        ['2026-01-01T00:00:03.000000Z', 'b1'],
        ['2026-01-01T00:00:02.500000Z', 'b2'],
      ] as const;
      for (const [stamp, targetId] of bRows) {
        await db.insert(auditLog).values({
          organizationId: tenantB.organizationId,
          actorType: 'user',
          action: 'audit_log_viewed',
          targetType: 'organization',
          targetId,
          metadata: {},
          createdAt: sql`${stamp}::timestamptz`,
        });
      }

      const replay = await repo.list(ownerScope(tenantB), tenantB.organizationId, {
        cursor: fromA.nextCursor!,
      });
      expect(replay.items.every((r) => r.organizationId === tenantB.organizationId)).toBe(true);
      expect(replay.items.map((r) => r.targetId)).toEqual(['b1', 'b2']);

      // And the scope still decides: B's scope can't read A even holding A's cursor.
      await expect(
        repo.list(ownerScope(tenantB), tenantA.organizationId, { cursor: fromA.nextCursor! }),
      ).rejects.toThrow(TenantScopeViolationError);
    } finally {
      await cleanupTestTenant(tenantA);
      await cleanupTestTenant(tenantB);
    }
  });

  it('gives an opaque cursor that reveals no position or id in the clear', async () => {
    await withTenant('audit-cursor', async (tenant) => {
      await seedRows(tenant);
      const page = await createAuditLogRepository(db).list(
        ownerScope(tenant),
        tenant.organizationId,
        { limit: 2 },
      );
      expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(page.nextCursor).not.toMatch(/2026|-/);
    });
  });

  it('clamps the page size to the maximum and to at least one', async () => {
    await withTenant('audit-limit', async (tenant) => {
      const repo = createAuditLogRepository(db);
      const scope = ownerScope(tenant);
      for (let i = 0; i < 3; i++) await repo.write(scope, viewed(tenant.organizationId));
      expect((await repo.list(scope, tenant.organizationId, { limit: 0 })).items).toHaveLength(1);
      expect(
        (await repo.list(scope, tenant.organizationId, { limit: MAX_AUDIT_PAGE_SIZE * 10 })).items,
      ).toHaveLength(3);
    });
  });

  it('filters by action and by an inclusive time range', async () => {
    await withTenant('audit-filter', async (tenant) => {
      await seedRows(tenant);
      const repo = createAuditLogRepository(db);
      const scope = ownerScope(tenant);
      const removed = await repo.list(scope, tenant.organizationId, { action: 'member_removed' });
      expect(removed.items.map((r) => r.targetId)).toEqual(['row-6']);

      const range = await repo.list(scope, tenant.organizationId, {
        from: new Date('2026-01-01T00:00:02.000Z'),
        to: new Date('2026-01-01T00:00:03.000Z'),
      });
      expect(range.items.map((r) => r.targetId)).toEqual(['row-5']);
    });
  });

  it.each([
    '',
    'not-a-cursor',
    'e30',
    Buffer.from('{"v":1,"t":"x","i":"y"}').toString('base64url'),
    Buffer.from(
      JSON.stringify({ v: 2, t: '2026-01-01T00:00:03.123456Z', i: randomUUID() }),
    ).toString('base64url'),
  ])('rejects the malformed cursor %j', async (cursor) => {
    await withTenant('audit-bad-cursor', async (tenant) => {
      // An empty string means "no cursor"; everything else must be rejected.
      const call = createAuditLogRepository(db).list(ownerScope(tenant), tenant.organizationId, {
        cursor,
      });
      if (cursor === '') await expect(call).resolves.toBeDefined();
      else await expect(call).rejects.toThrow(InvalidAuditCursorError);
    });
  });

  it('refuses an action filter outside the catalogue', async () => {
    await withTenant('audit-bad-action', async (tenant) => {
      await expect(
        createAuditLogRepository(db).list(ownerScope(tenant), tenant.organizationId, {
          // @ts-expect-error not in the catalogue
          action: 'made_up',
        }),
      ).rejects.toThrow(/unknown audit action/);
    });
  });
});
