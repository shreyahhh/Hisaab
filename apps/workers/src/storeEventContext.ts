import { createChannelRuleRepository, createStoreRepository, type Db } from '@truepath/db';
import { parseChannelRules, storeBoundScope, type ChannelRule } from '@truepath/shared';

// What `event-workers` needs to know about a store to classify its traffic (event-pipeline.md §3:
// `channel_rules` and `stores.shop_domain`, "cached 60 s per store"). Read through the scoped
// repositories with a scope that covers exactly that one store (ADR-0016).

export interface StoreEventContext {
  /** The shop's own hosts, so a same-site referrer counts as no referrer. */
  readonly shopHosts: readonly string[];
  readonly rules: readonly ChannelRule[];
  /** Ids of `channel_rules` rows that failed validation and were skipped. */
  readonly ignoredRuleIds: readonly string[];
}

export const STORE_CONTEXT_TTL_MS = 60_000;

export interface StoreContextSource {
  /** Null for a store that doesn't exist (or is deleted): its entries are dropped. */
  get(storeId: string): Promise<StoreEventContext | null>;
}

export class StoreContextCache implements StoreContextSource {
  private readonly entries = new Map<string, { at: number; value: StoreEventContext }>();

  constructor(
    private readonly db: Db,
    private readonly nowMs: () => number = Date.now,
    private readonly ttlMs: number = STORE_CONTEXT_TTL_MS,
  ) {}

  async get(storeId: string): Promise<StoreEventContext | null> {
    const cached = this.entries.get(storeId);
    if (cached && this.nowMs() - cached.at < this.ttlMs) return cached.value;

    const scope = storeBoundScope(storeId);
    const store = await createStoreRepository(this.db).getById(scope, storeId);
    // A missing store is not cached: it may simply not have replicated yet, and a lookup is cheap.
    if (!store || store.status === 'deleted') return null;

    const rows = await createChannelRuleRepository(this.db).listByStore(scope, storeId);
    const { rules, ignored } = parseChannelRules(rows);
    const value: StoreEventContext = {
      shopHosts: [store.shopDomain],
      rules,
      ignoredRuleIds: ignored,
    };
    this.entries.set(storeId, { at: this.nowMs(), value });
    return value;
  }
}
