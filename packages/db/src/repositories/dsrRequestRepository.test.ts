import type { TenantScope } from '@truepath/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDsrRequestRepository } from './dsrRequestRepository.js';
import { dsrRequests } from '../schema/index.js';
import { cleanupTestTenant, db, seedTestTenant } from '../testing.js';

function jobScope(organizationId: string, storeId: string): TenantScope {
  return {
    kind: 'tenant',
    userId: null,
    organizationId,
    role: 'job',
    storeIds: new Set([storeId]),
  };
}

describe('DsrRequestRepository (shopify-integration.md §4.3)', () => {
  it('creates a receipt row for a compliance webhook', async () => {
    const tenant = await seedTestTenant('dsr-repo');
    try {
      const repo = createDsrRequestRepository(db);
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      const { row, created } = await repo.createFromWebhook(scope, {
        storeId: tenant.storeId,
        type: 'erasure',
        identityHash: 'k1:' + 'a'.repeat(64),
        dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        sourceRef: 'webhook-id-1',
      });
      expect(created).toBe(true);
      expect(row.type).toBe('erasure');
      expect(row.status).toBe('pending');
      expect((row.resultSummary as Record<string, unknown>).trigger).toBe('shopify_webhook');
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('createFromMerchant: creates a row with trigger=merchant, no dedupe key (issue #92)', async () => {
    const tenant = await seedTestTenant('dsr-repo-merchant');
    try {
      const repo = createDsrRequestRepository(db);
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      const row = await repo.createFromMerchant(scope, {
        storeId: tenant.storeId,
        type: 'correction',
        identityHash: 'k1:' + 'd'.repeat(64),
        dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
      expect(row.type).toBe('correction');
      expect(row.status).toBe('pending');
      expect((row.resultSummary as Record<string, unknown>).trigger).toBe('merchant');

      // Unlike createFromWebhook, two calls with the same identity hash are two separate rows —
      // there's no sourceRef to dedupe on; each merchant click is a deliberate new request.
      const second = await repo.createFromMerchant(scope, {
        storeId: tenant.storeId,
        type: 'correction',
        identityHash: 'k1:' + 'd'.repeat(64),
        dueAt: new Date(),
      });
      expect(second.id).not.toBe(row.id);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('allows a null identity_hash for store_erasure (shop/redact has no shopper identity)', async () => {
    const tenant = await seedTestTenant('dsr-repo-store-erasure');
    try {
      const repo = createDsrRequestRepository(db);
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      const { row } = await repo.createFromWebhook(scope, {
        storeId: tenant.storeId,
        type: 'store_erasure',
        identityHash: null,
        dueAt: new Date(),
        sourceRef: 'webhook-id-2',
      });
      expect(row.identityHash).toBeNull();
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('is idempotent: a retried webhook with the same source_ref does not create a second row', async () => {
    const tenant = await seedTestTenant('dsr-repo-dedupe');
    try {
      const repo = createDsrRequestRepository(db);
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      const input = {
        storeId: tenant.storeId,
        type: 'access' as const,
        identityHash: 'k1:' + 'b'.repeat(64),
        dueAt: new Date(),
        sourceRef: 'webhook-id-3',
      };
      const first = await repo.createFromWebhook(scope, input);
      const retry = await repo.createFromWebhook(scope, input);

      expect(first.created).toBe(true);
      expect(retry.created).toBe(false);
      expect(retry.row.id).toBe(first.row.id);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('the same source_ref in a different store does not collide (dedupe is per-store)', async () => {
    const tenantA = await seedTestTenant('dsr-repo-a');
    const tenantB = await seedTestTenant('dsr-repo-b');
    try {
      const repo = createDsrRequestRepository(db);
      const sharedRef = 'shared-webhook-id';
      const a = await repo.createFromWebhook(jobScope(tenantA.organizationId, tenantA.storeId), {
        storeId: tenantA.storeId,
        type: 'access',
        identityHash: null,
        dueAt: new Date(),
        sourceRef: sharedRef,
      });
      const b = await repo.createFromWebhook(jobScope(tenantB.organizationId, tenantB.storeId), {
        storeId: tenantB.storeId,
        type: 'access',
        identityHash: null,
        dueAt: new Date(),
        sourceRef: sharedRef,
      });
      expect(a.created).toBe(true);
      expect(b.created).toBe(true);
      expect(a.row.id).not.toBe(b.row.id);
    } finally {
      await cleanupTestTenant(tenantA);
      await cleanupTestTenant(tenantB);
    }
  });
});

describe('DsrRequestRepository — status transitions (issue #25)', () => {
  async function seedPending(label: string) {
    const tenant = await seedTestTenant(label);
    const repo = createDsrRequestRepository(db);
    const scope = jobScope(tenant.organizationId, tenant.storeId);
    const { row } = await repo.createFromWebhook(scope, {
      storeId: tenant.storeId,
      type: 'erasure',
      identityHash: 'k1:' + 'c'.repeat(64),
      dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      sourceRef: `${label}-webhook`,
    });
    return { tenant, scope, repo, requestId: row.id };
  }

  describe('beginProcessing', () => {
    it('moves pending to in_progress', async () => {
      const { tenant, scope, repo, requestId } = await seedPending('dsr-begin-pending');
      try {
        const result = await repo.beginProcessing(scope, tenant.storeId, requestId);
        expect(result.alreadyCompleted).toBe(false);
        expect(result.row.status).toBe('in_progress');
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it('is idempotent against an already-completed row: no-op, alreadyCompleted true', async () => {
      const { tenant, scope, repo, requestId } = await seedPending('dsr-begin-completed');
      try {
        await repo.beginProcessing(scope, tenant.storeId, requestId);
        const completed = await repo.complete(scope, tenant.storeId, requestId, {
          resultSummaryPatch: { events: 0 },
          completedAt: new Date(),
        });
        expect(completed.status).toBe('completed');

        const result = await repo.beginProcessing(scope, tenant.storeId, requestId);
        expect(result.alreadyCompleted).toBe(true);
        expect(result.row.status).toBe('completed'); // untouched, not reset to in_progress
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it('resumes a previously-failed job', async () => {
      const { tenant, scope, repo, requestId } = await seedPending('dsr-begin-failed');
      try {
        await repo.fail(scope, tenant.storeId, requestId);
        const result = await repo.beginProcessing(scope, tenant.storeId, requestId);
        expect(result.alreadyCompleted).toBe(false);
        expect(result.row.status).toBe('in_progress');
      } finally {
        await cleanupTestTenant(tenant);
      }
    });
  });

  describe('complete', () => {
    it('merges the patch into result_summary, preserving trigger/source_ref, and sets completed_at', async () => {
      const { tenant, scope, repo, requestId } = await seedPending('dsr-complete-merge');
      try {
        const completedAt = new Date('2026-10-01T10:00:00.000Z');
        const row = await repo.complete(scope, tenant.storeId, requestId, {
          resultSummaryPatch: { events: 3, touchpoints: 5 },
          completedAt,
        });
        expect(row.status).toBe('completed');
        expect(row.completedAt?.toISOString()).toBe(completedAt.toISOString());
        expect(row.resultSummary).toMatchObject({
          trigger: 'shopify_webhook',
          source_ref: 'dsr-complete-merge-webhook',
          events: 3,
          touchpoints: 5,
        });
      } finally {
        await cleanupTestTenant(tenant);
      }
    });
  });

  describe('fail', () => {
    it('sets status to failed', async () => {
      const { tenant, scope, repo, requestId } = await seedPending('dsr-fail');
      try {
        const row = await repo.fail(scope, tenant.storeId, requestId);
        expect(row.status).toBe('failed');
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it('never downgrades an already-completed row (a follow-up purge failing must not un-complete the original erasure)', async () => {
      const { tenant, scope, repo, requestId } = await seedPending('dsr-fail-completed');
      try {
        await repo.complete(scope, tenant.storeId, requestId, {
          resultSummaryPatch: {},
          completedAt: new Date(),
        });
        const row = await repo.fail(scope, tenant.storeId, requestId);
        expect(row.status).toBe('completed');
      } finally {
        await cleanupTestTenant(tenant);
      }
    });
  });

  describe('appendFollowup', () => {
    it('appends an entry to result_summary.followups[]', async () => {
      const { tenant, scope, repo, requestId } = await seedPending('dsr-followup-append');
      try {
        await repo.complete(scope, tenant.storeId, requestId, {
          resultSummaryPatch: {},
          completedAt: new Date(),
        });
        const at = new Date('2026-10-01T11:00:00.000Z');
        const result = await repo.appendFollowup(scope, tenant.storeId, requestId, {
          followupKey: 'suppression-row-1',
          visitorCount: 1,
          rowsDeleted: 4,
          at,
        });
        expect(result.appended).toBe(true);

        const [row] = await repo.listRecentByStore(scope, tenant.storeId, 1);
        expect(row?.resultSummary).toMatchObject({
          followups: [
            {
              followup_key: 'suppression-row-1',
              visitor_count: 1,
              rows_deleted: 4,
              at: at.toISOString(),
            },
          ],
        });
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it('is idempotent: a repeated followupKey is not appended twice', async () => {
      const { tenant, scope, repo, requestId } = await seedPending('dsr-followup-idempotent');
      try {
        await repo.complete(scope, tenant.storeId, requestId, {
          resultSummaryPatch: {},
          completedAt: new Date(),
        });
        const entry = {
          followupKey: 'suppression-row-dup',
          visitorCount: 1,
          rowsDeleted: 2,
          at: new Date(),
        };
        const first = await repo.appendFollowup(scope, tenant.storeId, requestId, entry);
        const second = await repo.appendFollowup(scope, tenant.storeId, requestId, entry);
        expect(first.appended).toBe(true);
        expect(second.appended).toBe(false);

        const [row] = await repo.listRecentByStore(scope, tenant.storeId, 1);
        const followups = (row?.resultSummary as { followups?: unknown[] } | null)?.followups ?? [];
        expect(followups).toHaveLength(1);
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it('two different followupKeys both land', async () => {
      const { tenant, scope, repo, requestId } = await seedPending('dsr-followup-multiple');
      try {
        await repo.complete(scope, tenant.storeId, requestId, {
          resultSummaryPatch: {},
          completedAt: new Date(),
        });
        await repo.appendFollowup(scope, tenant.storeId, requestId, {
          followupKey: 'row-1',
          visitorCount: 1,
          rowsDeleted: 1,
          at: new Date(),
        });
        await repo.appendFollowup(scope, tenant.storeId, requestId, {
          followupKey: 'row-2',
          visitorCount: 1,
          rowsDeleted: 1,
          at: new Date(),
        });
        const [row] = await repo.listRecentByStore(scope, tenant.storeId, 1);
        const followups = (row?.resultSummary as { followups?: unknown[] } | null)?.followups ?? [];
        expect(followups).toHaveLength(2);
      } finally {
        await cleanupTestTenant(tenant);
      }
    });
  });

  describe('claimPendingWithdrawalBatch (issue #93, privacy-dpdp.md §4.5 step 2)', () => {
    async function seedWithdrawal(tenant: Awaited<ReturnType<typeof seedTestTenant>>) {
      const [row] = await db
        .insert(dsrRequests)
        .values({
          storeId: tenant.storeId,
          type: 'erasure',
          identityHash: null,
          dueAt: new Date(Date.now() + 86_400_000),
          resultSummary: { trigger: 'consent_withdrawn' },
        })
        .returning();
      return row!;
    }

    it('claims other pending withdrawal requests, excludes the given one, and flips them to in_progress', async () => {
      const { tenant, scope, repo, requestId } = await seedPending('dsr-claim-exclude');
      try {
        const withdrawal1 = await seedWithdrawal(tenant);
        const withdrawal2 = await seedWithdrawal(tenant);

        const claimed = await repo.claimPendingWithdrawalBatch(
          scope,
          tenant.storeId,
          withdrawal1.id,
          500,
        );
        const claimedIds = claimed.map((r) => r.id).sort();
        expect(claimedIds).toEqual([withdrawal2.id].sort());
        expect(claimed.every((r) => r.status === 'in_progress')).toBe(true);

        // The excluded id and the unrelated shopify_webhook-triggered row are both left alone.
        const [untouched] = await db
          .select()
          .from(dsrRequests)
          .where(eq(dsrRequests.id, withdrawal1.id));
        expect(untouched!.status).toBe('pending');
        const [other] = await db.select().from(dsrRequests).where(eq(dsrRequests.id, requestId));
        expect(other!.status).toBe('pending');
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it('does not claim an already-completed or a different trigger', async () => {
      const {
        tenant,
        scope,
        repo,
        requestId: completedId,
      } = await seedPending('dsr-claim-skip-completed');
      try {
        await repo.complete(scope, tenant.storeId, completedId, {
          resultSummaryPatch: {},
          completedAt: new Date(),
        });
        const withdrawal = await seedWithdrawal(tenant);

        const claimed = await repo.claimPendingWithdrawalBatch(
          scope,
          tenant.storeId,
          withdrawal.id,
          500,
        );
        // Only the webhook-triggered row exists besides `withdrawal` itself, and it's both the
        // wrong trigger and already completed — neither makes it eligible.
        expect(claimed.map((r) => r.id)).not.toContain(completedId);
      } finally {
        await cleanupTestTenant(tenant);
      }
    });

    it('respects the limit', async () => {
      const tenant = await seedTestTenant('dsr-claim-limit');
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      try {
        const repo = createDsrRequestRepository(db);
        const seeded = [
          await seedWithdrawal(tenant),
          await seedWithdrawal(tenant),
          await seedWithdrawal(tenant),
        ];
        const claimed = await repo.claimPendingWithdrawalBatch(
          scope,
          tenant.storeId,
          seeded[0]!.id,
          1,
        );
        expect(claimed).toHaveLength(1);
      } finally {
        await cleanupTestTenant(tenant);
      }
    });
  });
});
