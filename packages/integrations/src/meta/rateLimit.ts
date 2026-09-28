// Meta rate-limit handling (meta-integration.md §2.3). Pure: parses the `x-business-use-case-usage`
// response header and Graph API error bodies, and decides what to do — no network, no timers, so the
// decision logic is fully unit-testable without a live account.

/** One ad account's entry under `x-business-use-case-usage` for the `ads_insights` use case. */
export interface BusinessUseCaseUsage {
  readonly accountId: string;
  readonly callCount: number;
  readonly totalCputime: number;
  readonly totalTime: number;
  /** Minutes until the account's usage resets, when Meta has already throttled it; 0 otherwise. */
  readonly estimatedTimeToRegainAccess: number;
}

/**
 * `x-business-use-case-usage` is `{ "<act_id>": [ { call_count, total_cputime, total_time,
 * estimated_time_to_regain_access } ] }` — an object of arrays, one array entry per use case sharing
 * that header (LLD: type `ads_insights`). Missing, malformed, or JSON-invalid input parses to `[]`, so a
 * caller always gets a usable (empty) list rather than having to guard for `null`/throw.
 */
export function parseBusinessUseCaseUsage(
  headerValue: string | null | undefined,
): BusinessUseCaseUsage[] {
  if (!headerValue) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(headerValue);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];

  const out: BusinessUseCaseUsage[] = [];
  for (const [accountId, entries] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
      out.push({
        accountId,
        callCount: num(e['call_count']),
        totalCputime: num(e['total_cputime']),
        totalTime: num(e['total_time']),
        estimatedTimeToRegainAccess: num(e['estimated_time_to_regain_access']),
      });
    }
  }
  return out;
}

export type RateLimitDecision =
  | { readonly action: 'proceed' }
  /** Any usage metric ≥ 75: pause this long before the next page (LLD: 60 s). */
  | { readonly action: 'pause'; readonly delayMs: number }
  /** `estimated_time_to_regain_access > 0`: Meta has already throttled the account; wait that long. */
  | { readonly action: 'backoff'; readonly delayMs: number };

const PAUSE_THRESHOLD = 75;
export const RATE_LIMIT_PAUSE_MS = 60_000;

/** meta-integration.md §2.3's usage-header rule, evaluated over every account in the header (worst wins). */
export function decideRateLimit(usage: readonly BusinessUseCaseUsage[]): RateLimitDecision {
  let worstBackoffMinutes = 0;
  let anyOverThreshold = false;
  for (const u of usage) {
    if (u.estimatedTimeToRegainAccess > worstBackoffMinutes) {
      worstBackoffMinutes = u.estimatedTimeToRegainAccess;
    }
    if (
      u.callCount >= PAUSE_THRESHOLD ||
      u.totalCputime >= PAUSE_THRESHOLD ||
      u.totalTime >= PAUSE_THRESHOLD
    ) {
      anyOverThreshold = true;
    }
  }
  if (worstBackoffMinutes > 0) return { action: 'backoff', delayMs: worstBackoffMinutes * 60_000 };
  if (anyOverThreshold) return { action: 'pause', delayMs: RATE_LIMIT_PAUSE_MS };
  return { action: 'proceed' };
}

/** Graph API error codes/subcodes the LLD names as throttling (§2.3): 17/613 at API level, 80000/80004 at business-use-case level. */
const THROTTLE_CODES = new Set([17, 613]);
const THROTTLE_SUBCODES = new Set([80000, 80004]);

export interface GraphApiError {
  readonly code: number;
  readonly errorSubcode?: number;
  readonly message: string;
  readonly fbtraceId?: string;
}

/** Meta's error envelope: `{ error: { message, type, code, error_subcode?, fbtrace_id? } }`. */
export function parseGraphApiError(body: unknown): GraphApiError | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const e = error as Record<string, unknown>;
  if (typeof e['code'] !== 'number') return null;
  return {
    code: e['code'],
    ...(typeof e['error_subcode'] === 'number' ? { errorSubcode: e['error_subcode'] } : {}),
    message: typeof e['message'] === 'string' ? e['message'] : 'unknown Graph API error',
    ...(typeof e['fbtrace_id'] === 'string' ? { fbtraceId: e['fbtrace_id'] } : {}),
  };
}

export function isThrottleError(error: GraphApiError): boolean {
  return (
    THROTTLE_CODES.has(error.code) ||
    (error.errorSubcode !== undefined && THROTTLE_SUBCODES.has(error.errorSubcode))
  );
}

/** meta-integration.md §2.3: exponential backoff 30 s → 16 min over 6 tries. `attempt` is 1-based. */
export function throttleBackoffMs(attempt: number): number {
  const MAX_MS = 16 * 60_000;
  return Math.min(30_000 * 2 ** (attempt - 1), MAX_MS);
}
export const THROTTLE_MAX_ATTEMPTS = 6;
