import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { assertStoreInScope, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { dsrRequests } from '../schema/index.js';

export type DsrRequestRow = typeof dsrRequests.$inferSelect;

export interface CreateDsrRequestFromWebhookInput {
  readonly storeId: string;
  readonly type: 'access' | 'erasure' | 'store_erasure';
  /** null for `store_erasure` — it is store-wide, not tied to one shopper (privacy-dpdp.md line 196). */
  readonly identityHash: string | null;
  readonly dueAt: Date;
  /** Dedupe key (shopify-integration.md §4.3): `X-Shopify-Webhook-Id` for this delivery. */
  readonly sourceRef: string;
}

export interface CompleteDsrRequestInput {
  /** Merged into the existing jsonb `result_summary` (preserving `trigger`/`source_ref`) — per-target
   * deleted counts, `guard_rejected_hashes`, etc. Ids/enums/counts only, same rule as audit metadata. */
  readonly resultSummaryPatch: Record<string, unknown>;
  readonly completedAt: Date;
}

export interface AppendFollowupInput {
  /** The triggering suppression row's id — makes a redelivered follow-up job's append a no-op. */
  readonly followupKey: string;
  readonly visitorCount: number;
  readonly rowsDeleted: number;
  readonly at: Date;
}

export interface DsrRequestRepository {
  /**
   * Records receipt of a Shopify compliance webhook (`customers/data_request` | `customers/redact` |
   * `shop/redact`) durably, exactly once per `(storeId, sourceRef)` — a Shopify retry of the same
   * webhook delivery creates no second row (CLAUDE.md "Webhooks: verify, dedupe"). This is the
   * *receipt*, not fulfilment: turning the row into an actual export/erasure is a separate, later
   * pipeline (privacy-dpdp.md).
   */
  createFromWebhook(
    scope: Scope,
    input: CreateDsrRequestFromWebhookInput,
  ): Promise<{ readonly row: DsrRequestRow; readonly created: boolean }>;

  /** The store's most recent DSR requests, newest first — SPEC §10 `GET /v1/stores/:id/privacy/requests`. */
  listRecentByStore(scope: Scope, storeId: string, limit: number): Promise<DsrRequestRow[]>;

  /**
   * `pending`/`failed` → `in_progress` (a retry of a previously-failed job resumes it). Idempotent
   * against redelivery of an already-`completed` job: `alreadyCompleted: true` and nothing is
   * written, so the `dsr` worker's caller can skip re-running a finished erasure.
   */
  beginProcessing(
    scope: Scope,
    storeId: string,
    requestId: string,
  ): Promise<{ readonly row: DsrRequestRow; readonly alreadyCompleted: boolean }>;

  /** `status='completed'`, merges `resultSummaryPatch` into the existing `result_summary`. */
  complete(
    scope: Scope,
    storeId: string,
    requestId: string,
    input: CompleteDsrRequestInput,
  ): Promise<DsrRequestRow>;

  /** `status='failed'` — the job exhausted its BullMQ retries (DSR_JOB_OPTIONS: 5 attempts). */
  fail(scope: Scope, storeId: string, requestId: string): Promise<DsrRequestRow>;

  /**
   * privacy-dpdp.md §4.4 step 9: appends one entry to `result_summary.followups[]`, keyed by
   * `followupKey` so a redelivered follow-up job (same suppression row) is a no-op, not a duplicate
   * entry. `SELECT ... FOR UPDATE` serialises concurrent follow-ups for the same request.
   */
  appendFollowup(
    scope: Scope,
    storeId: string,
    requestId: string,
    input: AppendFollowupInput,
  ): Promise<{ readonly appended: boolean }>;
}

/** The only sanctioned way to write `dsr_requests` from a webhook (ADR-0016). */
export function createDsrRequestRepository(db: Db): DsrRequestRepository {
  return {
    async createFromWebhook(scope, input) {
      assertStoreInScope(scope, input.storeId);

      const inserted = await db
        .insert(dsrRequests)
        .values({
          storeId: input.storeId,
          type: input.type,
          identityHash: input.identityHash,
          dueAt: input.dueAt,
          resultSummary: { trigger: 'shopify_webhook', source_ref: input.sourceRef },
        })
        // No explicit target: dsr_requests has exactly one meaningful unique constraint besides its
        // primary key (the partial source_ref index), so a plain ON CONFLICT DO NOTHING is
        // unambiguous and needs no expression-index target syntax.
        .onConflictDoNothing()
        .returning();
      const created = inserted[0];
      if (created) return { row: created, created: true };

      const existingRows = await db
        .select()
        .from(dsrRequests)
        .where(
          and(
            eq(dsrRequests.storeId, input.storeId),
            sql`(${dsrRequests.resultSummary}->>'source_ref') = ${input.sourceRef}`,
          ),
        )
        .limit(1);
      const existing = existingRows[0];
      if (!existing) throw new Error('createFromWebhook: conflicted but no row was found');
      return { row: existing, created: false };
    },

    async listRecentByStore(scope, storeId, limit) {
      assertStoreInScope(scope, storeId);
      return db
        .select()
        .from(dsrRequests)
        .where(eq(dsrRequests.storeId, storeId))
        .orderBy(desc(dsrRequests.createdAt))
        .limit(limit);
    },

    async beginProcessing(scope, storeId, requestId) {
      assertStoreInScope(scope, storeId);
      const [updated] = await db
        .update(dsrRequests)
        .set({ status: 'in_progress' })
        .where(
          and(
            eq(dsrRequests.id, requestId),
            eq(dsrRequests.storeId, storeId),
            ne(dsrRequests.status, 'completed'),
          ),
        )
        .returning();
      if (updated) return { row: updated, alreadyCompleted: false };

      const [existing] = await db
        .select()
        .from(dsrRequests)
        .where(and(eq(dsrRequests.id, requestId), eq(dsrRequests.storeId, storeId)));
      if (!existing) throw new Error('beginProcessing: no such dsr_requests row');
      return { row: existing, alreadyCompleted: true };
    },

    async complete(scope, storeId, requestId, input) {
      assertStoreInScope(scope, storeId);
      const [row] = await db
        .update(dsrRequests)
        .set({
          status: 'completed',
          completedAt: input.completedAt,
          resultSummary: sql`coalesce(${dsrRequests.resultSummary}, '{}'::jsonb) || ${JSON.stringify(input.resultSummaryPatch)}::jsonb`,
        })
        .where(and(eq(dsrRequests.id, requestId), eq(dsrRequests.storeId, storeId)))
        .returning();
      if (!row) throw new Error('complete: no such dsr_requests row');
      return row;
    },

    async fail(scope, storeId, requestId) {
      assertStoreInScope(scope, storeId);
      const [row] = await db
        .update(dsrRequests)
        .set({ status: 'failed' })
        .where(and(eq(dsrRequests.id, requestId), eq(dsrRequests.storeId, storeId)))
        .returning();
      if (!row) throw new Error('fail: no such dsr_requests row');
      return row;
    },

    async appendFollowup(scope, storeId, requestId, input) {
      assertStoreInScope(scope, storeId);
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ resultSummary: dsrRequests.resultSummary })
          .from(dsrRequests)
          .where(and(eq(dsrRequests.id, requestId), eq(dsrRequests.storeId, storeId)))
          .for('update');
        if (!existing) throw new Error('appendFollowup: no such dsr_requests row');

        const summary = (existing.resultSummary ?? {}) as Record<string, unknown>;
        const followups = Array.isArray(summary['followups'])
          ? (summary['followups'] as ReadonlyArray<Record<string, unknown>>)
          : [];
        if (followups.some((f) => f['followup_key'] === input.followupKey)) {
          return { appended: false };
        }

        const patch = {
          followups: [
            ...followups,
            {
              followup_key: input.followupKey,
              visitor_count: input.visitorCount,
              rows_deleted: input.rowsDeleted,
              at: input.at.toISOString(),
            },
          ],
        };
        await tx
          .update(dsrRequests)
          .set({
            resultSummary: sql`coalesce(${dsrRequests.resultSummary}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
          })
          .where(and(eq(dsrRequests.id, requestId), eq(dsrRequests.storeId, storeId)));
        return { appended: true };
      });
    },
  };
}
