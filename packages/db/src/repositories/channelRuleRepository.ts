import { asc, eq } from 'drizzle-orm';
import { assertStoreInScope, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { channelRules } from '../schema/index.js';

export type ChannelRuleRow = typeof channelRules.$inferSelect;

export interface ChannelRuleRepository {
  /**
   * The store's merchant `channel_rules`, lowest priority number first (event-pipeline.md §2.3). Rows are
   * returned as stored: validating `match` is the caller's job (`parseChannelRules` in @truepath/shared),
   * so a malformed rule is skipped and reported rather than failing the read.
   */
  listByStore(scope: Scope, storeId: string): Promise<ChannelRuleRow[]>;
}

/** The only sanctioned way to read `channel_rules` (ADR-0016). */
export function createChannelRuleRepository(db: Db): ChannelRuleRepository {
  return {
    async listByStore(scope, storeId) {
      assertStoreInScope(scope, storeId);
      return db
        .select()
        .from(channelRules)
        .where(eq(channelRules.storeId, storeId))
        .orderBy(asc(channelRules.priority));
    },
  };
}
