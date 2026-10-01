import { and, desc, eq, inArray } from 'drizzle-orm';
import { assertStoreInScope, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { consentRecords } from '../schema/index.js';

export type ConsentRecordRow = typeof consentRecords.$inferSelect;

export interface ConsentRecordRepository {
  /** The store's most recent consent state changes, newest first — the Privacy page (SPEC §11 §8). */
  listRecentByStore(scope: Scope, storeId: string, limit: number): Promise<ConsentRecordRow[]>;
  /**
   * Issue #25 (privacy-dpdp.md §4.4 step 4 / §4.5 step 3): deletes every consent record for the given
   * `HMAC(visitor_id)` values. A no-op (0 deleted) for an empty list.
   */
  deleteByVisitorHmacs(
    scope: Scope,
    storeId: string,
    visitorHmacs: readonly string[],
  ): Promise<{ readonly deleted: number }>;
}

/** The only sanctioned way to read/write `consent_records` (ADR-0016). Written by event-workers (HLD §6a). */
export function createConsentRecordRepository(db: Db): ConsentRecordRepository {
  return {
    async listRecentByStore(scope, storeId, limit) {
      assertStoreInScope(scope, storeId);
      return db
        .select()
        .from(consentRecords)
        .where(eq(consentRecords.storeId, storeId))
        .orderBy(desc(consentRecords.occurredAt))
        .limit(limit);
    },

    async deleteByVisitorHmacs(scope, storeId, visitorHmacs) {
      assertStoreInScope(scope, storeId);
      if (visitorHmacs.length === 0) return { deleted: 0 };
      const deleted = await db
        .delete(consentRecords)
        .where(
          and(
            eq(consentRecords.storeId, storeId),
            inArray(consentRecords.visitorId, [...visitorHmacs]),
          ),
        )
        .returning({ id: consentRecords.id });
      return { deleted: deleted.length };
    },
  };
}
