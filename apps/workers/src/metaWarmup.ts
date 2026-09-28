import { ch, type ClickHouseClient } from '@truepath/clickhouse';
import { createAdAccountRepository, createIntegrationRepository, type Db } from '@truepath/db';
import type { CredentialsCipher } from '@truepath/privacy';
import type { MetaAdapter, MetaCredentials } from '@truepath/integrations';
import { storeBoundScope, type AdSyncMetaJob } from '@truepath/shared';

// `meta-warmup` (M1-8, meta-integration.md §2.2, §4.2): a thin, read-only insights pull, run every 15
// minutes for each store that has registered a Meta account, to build the call history App Review's
// Advanced Access needs. It writes real rows to `ad_spend_daily` (useful data, not just a ping) and
// keeps a running success/error ledger in `integrations.settings.warmup` so that count is visible without
// a live dashboard. The full daily/intraday sync (meta-daily/meta-intraday) is M2 — this only ever
// touches the accounts the operator CLI registered.

export interface MetaWarmupDeps {
  readonly db: Db;
  readonly clickhouse: ClickHouseClient;
  readonly cipher: CredentialsCipher;
  readonly adapter: MetaAdapter;
  readonly now: () => Date;
  readonly log: (line: Record<string, unknown>) => void;
}

export interface MetaWarmupResult {
  readonly accounts: number;
  readonly rowsWritten: number;
  readonly callsSuccess: number;
  readonly callsError: number;
}

function ymdInTimezone(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the Insights API's date_start/date_stop shape.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * "yesterday … today" in the ad account's own reporting timezone (meta-integration.md §2.2's
 * `meta-warmup` row). Subtracting a fixed 24h can occasionally land on the wrong calendar day around a
 * DST transition in `timezone`; a day's overlap or gap there self-heals (`ReplacingMergeTree` on
 * `(store_id, platform, date, campaign_id, ad_id)`, and the job runs again in 15 minutes regardless).
 */
export function warmupRange(timezone: string, now: Date): { since: string; until: string } {
  return {
    since: ymdInTimezone(new Date(now.getTime() - 24 * 3600_000), timezone),
    until: ymdInTimezone(now, timezone),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function asAccountIds(settings: unknown): string[] {
  const raw = asRecord(settings)['ad_account_ids'];
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Runs one warm-up pass for a store: pulls insights for every registered ad account (sequentially — see
 * below), writes what it got to `ad_spend_daily`, and updates the ledger. Never throws for an individual
 * account's failure; each is counted and logged (error *name* only — an error message can echo request
 * data) so one bad account doesn't stop the others or fail the whole BullMQ job.
 *
 * Accounts are processed **sequentially, in one JS call**, and the ledger is read-then-written with plain
 * (non-atomic) values rather than an SQL-level increment: with a single Workers process — true for every
 * environment this runs in during M1 — that is race-free, and it keeps `patchMetaWarmupState` a simple
 * merge. If a second Workers replica for this queue is ever run, this needs an atomic increment instead.
 */
export async function runMetaWarmup(
  deps: MetaWarmupDeps,
  job: AdSyncMetaJob,
): Promise<MetaWarmupResult> {
  const scope = storeBoundScope(job.storeId);
  const integrations = createIntegrationRepository(deps.db);
  const integration = await integrations.getActiveByStore(scope, job.storeId, 'meta');
  if (!integration?.encryptedCredentials) {
    return { accounts: 0, rowsWritten: 0, callsSuccess: 0, callsError: 0 };
  }
  const accountIds = asAccountIds(integration.settings);
  if (accountIds.length === 0)
    return { accounts: 0, rowsWritten: 0, callsSuccess: 0, callsError: 0 };

  const creds = JSON.parse(
    deps.cipher.decrypt({ integrationId: integration.id }, integration.encryptedCredentials),
  ) as MetaCredentials;
  const timezoneByAccount = new Map(
    (await createAdAccountRepository(deps.db).listByStore(scope, job.storeId, 'meta')).map((a) => [
      a.externalId,
      a.timezone,
    ]),
  );

  const now = deps.now();
  const warmup = asRecord(integration.settings)['warmup'];
  let callsTotal = asNumber(asRecord(warmup)['calls_total']);
  let callsSuccessTotal = asNumber(asRecord(warmup)['calls_success']);
  let callsErrorTotal = asNumber(asRecord(warmup)['calls_error']);
  let lastErrorCode: string | undefined;
  let rowsWritten = 0;
  let callsSuccess = 0;
  let callsError = 0;

  for (const accountId of accountIds) {
    const range = warmupRange(timezoneByAccount.get(accountId) ?? 'Asia/Kolkata', now);
    callsTotal += 1;
    try {
      const result = await deps.adapter.fetchInsights(creds, accountId, range);
      const rows = result.rows.map((r) => ({
        store_id: job.storeId,
        platform: 'meta',
        date: r.date,
        account_id: r.accountId,
        campaign_id: r.campaignId,
        campaign_name: r.campaignName,
        adset_id: r.adsetId,
        adset_name: r.adsetName,
        ad_id: r.adId,
        ad_name: r.adName,
        spend_paise: r.spendPaise,
        impressions: r.impressions,
        clicks: r.clicks,
        platform_conversions: r.platformConversions,
        platform_conversion_value_paise: r.platformConversionValuePaise,
        attribution_window: r.attributionWindow,
        synced_at: now.toISOString(),
      }));
      if (rows.length > 0)
        await ch(deps.clickhouse, scope, job.storeId).insert('ad_spend_daily', rows);
      rowsWritten += rows.length;
      callsSuccessTotal += 1;
      callsSuccess += 1;
      if (result.truncatedByRateLimit) {
        deps.log({
          event: 'meta_warmup_truncated_by_rate_limit',
          store_id: job.storeId,
          account_id: accountId,
        });
      }
    } catch (error) {
      callsErrorTotal += 1;
      callsError += 1;
      lastErrorCode = error instanceof Error ? error.name : 'unknown_error';
      deps.log({
        event: 'meta_warmup_account_failed',
        store_id: job.storeId,
        account_id: accountId,
        error_name: lastErrorCode,
      });
    }
  }

  await integrations.patchMetaWarmupState(scope, job.storeId, {
    calls_total: callsTotal,
    calls_success: callsSuccessTotal,
    calls_error: callsErrorTotal,
    last_run_at: now.toISOString(),
    ...(lastErrorCode ? { last_error_code: lastErrorCode } : {}),
  });

  deps.log({
    event: 'meta_warmup_run',
    store_id: job.storeId,
    accounts: accountIds.length,
    rows_written: rowsWritten,
    calls_success: callsSuccess,
    calls_error: callsError,
    calls_total_ledger: callsTotal,
    calls_success_ledger: callsSuccessTotal,
    calls_error_ledger: callsErrorTotal,
  });

  return { accounts: accountIds.length, rowsWritten, callsSuccess, callsError };
}
