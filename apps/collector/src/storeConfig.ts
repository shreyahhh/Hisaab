import type { Redis } from 'ioredis';
import { CollectorStoreConfig, STORE_KEY_PATTERN, collectorStoreKey } from '@truepath/shared';

// The Collector's view of `collector:store:<store_key>` (collector.md §2.5, HLD §8), cached in
// process for 30 s — misses too, so a flood of unknown keys never reaches Redis. The bound this puts
// on a config change (an `inactive` → `active` flip, or a DPA withdrawal going the other way) is
// therefore ≤ 30 s, and documented (collector.md §5).

export const STORE_CONFIG_TTL_MS = 30_000;
/** A bad key must not let an attacker fill the cache with distinct entries. */
const MAX_CACHED_KEYS = 50_000;

interface Entry {
  readonly config: CollectorStoreConfig | null;
  readonly expiresAt: number;
}

export class StoreConfigCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly redis: Pick<Redis, 'get'>,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = STORE_CONFIG_TTL_MS,
  ) {}

  /**
   * The config for a public store key, or null if there is none (unknown key, or a value that fails
   * the schema — treated the same, so a corrupt entry can't be used to probe). A Redis failure
   * throws: the caller answers 503, and the failure is not cached.
   */
  async get(storeKey: string): Promise<CollectorStoreConfig | null> {
    // Reject anything that can't be one of our keys before it costs a lookup or a cache slot.
    if (!STORE_KEY_PATTERN.test(storeKey)) return null;

    const nowMs = this.now();
    const cached = this.entries.get(storeKey);
    if (cached && cached.expiresAt > nowMs) return cached.config;

    const raw = await this.redis.get(collectorStoreKey(storeKey));
    let config: CollectorStoreConfig | null = null;
    if (raw) {
      try {
        const parsed = CollectorStoreConfig.safeParse(JSON.parse(raw));
        config = parsed.success ? parsed.data : null;
      } catch {
        config = null;
      }
    }
    if (this.entries.size >= MAX_CACHED_KEYS) this.entries.clear();
    this.entries.set(storeKey, { config, expiresAt: nowMs + this.ttlMs });
    return config;
  }

  /** For tests and an operator's "flush now". */
  clear(): void {
    this.entries.clear();
  }
}
