import { desc, eq } from 'drizzle-orm';
import { assertStoreInScope, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { consentRecords } from '../schema/index.js';

export type ConsentRecordRow = typeof consentRecords.$inferSelect;

export interface ConsentRecordRepository {
  /** The store's most recent consent state changes, newest first — the Privacy page (SPEC §11 §8). */
  listRecentByStore(scope: Scope, storeId: string, limit: number): Promise<ConsentRecordRow[]>;
}

/** The only sanctioned way to read `consent_records` (ADR-0016). Written by event-workers (HLD §6a). */
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
  };
}
