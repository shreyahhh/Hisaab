// Meta Marketing API types this adapter uses (meta-integration.md §2). Deliberately narrow: only what
// the M1-8 warm-up slice needs (read-only insights). Connection (OAuth), CAPI and the full daily/intraday
// sync are M2/M4.

export interface MetaCredentials {
  /** A Business Integration System User token: "default to never expire" (meta-integration.md §2.3). */
  readonly accessToken: string;
}

export interface MetaHealthStatus {
  readonly healthy: boolean;
  readonly reason?: string;
}

/** meta-integration.md §4.2: one `ad_spend_daily` row, before `store_id`/`platform`/`synced_at` are added. */
export interface MetaSpendRow {
  readonly date: string; // YYYY-MM-DD, the ad account's reporting timezone (date_start)
  readonly accountId: string;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly adsetId: string;
  readonly adsetName: string;
  readonly adId: string;
  readonly adName: string;
  readonly spendPaise: number;
  readonly impressions: number;
  readonly clicks: number;
  readonly platformConversions: number;
  readonly platformConversionValuePaise: number;
  readonly attributionWindow: string;
}

export interface MetaInsightsRange {
  /** YYYY-MM-DD, inclusive, in the ad account's own reporting timezone. */
  readonly since: string;
  readonly until: string;
}

export interface MetaInsightsResult {
  readonly rows: readonly MetaSpendRow[];
  /** True if a page was left unread because the rate-limit budget ran out mid-pull (§2.3). */
  readonly truncatedByRateLimit: boolean;
}
