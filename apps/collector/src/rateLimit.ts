// In-process token buckets (collector.md §7): per client IP by request, per store by event. No shared
// Redis limiter, to keep one round trip per request — so the effective limit is the per-task limit
// times the running task count. The numbers are placeholders until the load test (Open question 4);
// the per-IP one is deliberately generous because Indian mobile carriers put many shoppers behind
// shared CGNAT addresses.

export interface BucketConfig {
  /** Tokens added per second. */
  readonly ratePerSecond: number;
  /** Maximum tokens held (the burst). */
  readonly burst: number;
}

export const DEFAULT_IP_LIMIT: BucketConfig = { ratePerSecond: 30, burst: 60 };
export const DEFAULT_STORE_LIMIT: BucketConfig = { ratePerSecond: 500, burst: 1500 };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(
    private readonly config: BucketConfig,
    private readonly now: () => number = Date.now,
    /** Hard cap on tracked keys, so a flood of distinct keys can't grow memory without bound. */
    private readonly maxKeys = 100_000,
  ) {}

  /** Takes `cost` tokens for `key`; false (and nothing taken) if the bucket doesn't have them. */
  tryTake(key: string, cost = 1): boolean {
    const nowMs = this.now();
    this.sweep(nowMs);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) return false; // fail closed under a key-flood
      bucket = { tokens: this.config.burst, updatedAt: nowMs };
      this.buckets.set(key, bucket);
    } else {
      const elapsedSeconds = Math.max(0, nowMs - bucket.updatedAt) / 1000;
      bucket.tokens = Math.min(
        this.config.burst,
        bucket.tokens + elapsedSeconds * this.config.ratePerSecond,
      );
      bucket.updatedAt = nowMs;
    }
    // A request bigger than the burst can never succeed; charge at most the burst so a large batch
    // from a well-behaved client isn't refused forever.
    const charge = Math.min(cost, this.config.burst);
    if (bucket.tokens < charge) return false;
    bucket.tokens -= charge;
    return true;
  }

  /** Drops buckets that have refilled completely (indistinguishable from a fresh one), at most once a minute. */
  private sweep(nowMs: number): void {
    if (nowMs - this.lastSweep < 60_000) return;
    this.lastSweep = nowMs;
    const refillMs = (this.config.burst / this.config.ratePerSecond) * 1000;
    for (const [key, bucket] of this.buckets) {
      if (nowMs - bucket.updatedAt > refillMs) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
