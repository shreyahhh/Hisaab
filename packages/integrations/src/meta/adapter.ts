import { z } from 'zod';
import { InsightsRow, mapInsightsRow } from './mapper.js';
import {
  decideRateLimit,
  isThrottleError,
  parseBusinessUseCaseUsage,
  parseGraphApiError,
  throttleBackoffMs,
  THROTTLE_MAX_ATTEMPTS,
} from './rateLimit.js';
import type {
  MetaCredentials,
  MetaHealthStatus,
  MetaInsightsRange,
  MetaInsightsResult,
} from './types.js';

// Meta Marketing API adapter (meta-integration.md §2.3, §4.2) — the read-only slice M1-8's warm-up needs.
// Connection (Facebook Login for Business), the full daily/intraday sync, and CAPI are M2/M4; this
// covers only `GET act_<id>/insights` and a token health check.
//
// This deliberately implements only the SYNCHRONOUS insights call. The LLD's async Ad Report Run flow
// ("ranges over 7 days use an async job") is for the full sync's multi-week pulls; the warm-up's range
// (yesterday…today, per its job table) never needs it, so building the async path here would be
// speculative for a slice whose only job is to rack up successful calls before App Review.

// "Pinned to Marketing API v25.0 ... The version string lives in one constant in
// packages/integrations/meta; upgrades are one-line changes behind the adapter" (meta-integration.md,
// SPEC §0 rule 8) — confirmed still current against
// https://developers.facebook.com/docs/graph-api/changelog/versions (2026-09-29).
export const META_API_VERSION = 'v25.0';

const INSIGHTS_FIELDS = [
  'campaign_id',
  'campaign_name',
  'adset_id',
  'adset_name',
  'ad_id',
  'ad_name',
  'spend',
  'impressions',
  'clicks',
  'actions',
  'action_values',
].join(',');

const INSIGHTS_PAGE_LIMIT = 500;

export interface MetaAdapter {
  readonly provider: 'meta';
  /** A cheap authenticated call, to confirm the stored token still works. */
  healthCheck(creds: MetaCredentials): Promise<MetaHealthStatus>;
  /**
   * `GET act_<id>/insights`, `level=ad`, `time_increment=1`, paginated, with the LLD §2.3 rate-limit
   * handling: pauses 60 s between pages when any usage metric reaches 75, and retries a throttle error
   * (codes 17/613, subcodes 80000/80004) with exponential backoff (30 s → 16 min, 6 tries). If Meta has
   * already throttled the account (`estimated_time_to_regain_access > 0`), stops paging early rather
   * than waiting out a multi-minute backoff inline — `truncatedByRateLimit` says so, and the caller
   * (a job that runs again on its own schedule) picks up the rest next time.
   */
  fetchInsights(
    creds: MetaCredentials,
    accountId: string,
    range: MetaInsightsRange,
  ): Promise<MetaInsightsResult>;
}

const InsightsResponse = z.object({
  data: z.array(InsightsRow),
  paging: z.object({ cursors: z.object({ after: z.string().optional() }).optional() }).optional(),
});

function insightsUrl(accountId: string, range: MetaInsightsRange, after?: string): string {
  const params = new URLSearchParams({
    level: 'ad',
    time_increment: '1',
    time_range: JSON.stringify({ since: range.since, until: range.until }),
    fields: INSIGHTS_FIELDS,
    action_attribution_windows: JSON.stringify(['7d_click', '1d_view']),
    limit: String(INSIGHTS_PAGE_LIMIT),
    ...(after ? { after } : {}),
  });
  return `https://graph.facebook.com/${META_API_VERSION}/${accountId}/insights?${params.toString()}`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One page, with the LLD's throttle-error retry. Returns the parsed body and the usage header. */
async function fetchPage(
  url: string,
  creds: MetaCredentials,
  sleep: (ms: number) => Promise<void>,
): Promise<{ body: z.infer<typeof InsightsResponse>; usageHeader: string | null }> {
  for (let attempt = 1; attempt <= THROTTLE_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${creds.accessToken}` },
    });
    const json: unknown = await response.json();
    if (!response.ok) {
      const graphError = parseGraphApiError(json);
      if (graphError && isThrottleError(graphError) && attempt < THROTTLE_MAX_ATTEMPTS) {
        await sleep(throttleBackoffMs(attempt));
        continue;
      }
      throw new Error(
        `Meta Insights API returned ${response.status}${graphError ? `: ${graphError.code} ${graphError.message}` : ''}`,
      );
    }
    const parsed = InsightsResponse.safeParse(json);
    if (!parsed.success) {
      throw new Error('Meta Insights API returned an unexpected response shape');
    }
    return { body: parsed.data, usageHeader: response.headers.get('x-business-use-case-usage') };
  }
  // Unreachable: the loop above always returns or throws; satisfies TS's exhaustiveness check.
  throw new Error('fetchPage: exhausted retry attempts without a result');
}

async function fetchInsightsWith(
  sleep: (ms: number) => Promise<void>,
  creds: MetaCredentials,
  accountId: string,
  range: MetaInsightsRange,
): Promise<MetaInsightsResult> {
  const rows: MetaSpendRowMapped[] = [];
  let after: string | undefined;
  let truncatedByRateLimit = false;

  for (;;) {
    const { body, usageHeader } = await fetchPage(
      insightsUrl(accountId, range, after),
      creds,
      sleep,
    );
    for (const row of body.data) rows.push({ ...mapInsightsRow(row), accountId });

    const decision = decideRateLimit(parseBusinessUseCaseUsage(usageHeader));
    const next = body.paging?.cursors?.after;
    if (!next) break;

    if (decision.action === 'backoff') {
      truncatedByRateLimit = true;
      break;
    }
    if (decision.action === 'pause') await sleep(decision.delayMs);
    after = next;
  }

  return { rows, truncatedByRateLimit };
}

type MetaSpendRowMapped = ReturnType<typeof mapInsightsRow>;

const MeResponse = z.object({ id: z.string().min(1) });

/**
 * `sleep` is injectable only for tests (mirrors `apps/workers/src/eventConsumer.ts`'s pattern) — real
 * callers never pass it, and get the real timer-based wait between pages/retries.
 */
export function createMetaAdapter(
  options: { sleep?: (ms: number) => Promise<void> } = {},
): MetaAdapter {
  const sleep = options.sleep ?? defaultSleep;
  return {
    provider: 'meta',

    async healthCheck(creds) {
      try {
        const response = await fetch(
          `https://graph.facebook.com/${META_API_VERSION}/me?fields=id`,
          {
            headers: { authorization: `Bearer ${creds.accessToken}` },
          },
        );
        const json: unknown = await response.json();
        if (!response.ok) {
          const graphError = parseGraphApiError(json);
          return { healthy: false, reason: graphError?.message ?? `http_${response.status}` };
        }
        const parsed = MeResponse.safeParse(json);
        return parsed.success
          ? { healthy: true }
          : { healthy: false, reason: 'unexpected_response_shape' };
      } catch (error) {
        return { healthy: false, reason: error instanceof Error ? error.message : 'unknown_error' };
      }
    },

    fetchInsights: (creds, accountId, range) => fetchInsightsWith(sleep, creds, accountId, range),
  };
}
