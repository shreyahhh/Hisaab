import { afterAll, describe, expect, it, vi } from 'vitest';
import { ch, createClickHouseClient } from '@truepath/clickhouse';
import { createAdAccountRepository, createIntegrationRepository } from '@truepath/db';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '@truepath/db/testing';
import { createTestCredentialsCipher } from '@truepath/privacy/testing';
import {
  clickhouseEnvSchema,
  loadDotEnvIfPresent,
  loadEnv,
  storeBoundScope,
} from '@truepath/shared';
import type { MetaAdapter, MetaInsightsResult } from '@truepath/integrations';
import { runMetaWarmup, warmupRange, type MetaWarmupDeps } from './metaWarmup.js';

loadDotEnvIfPresent('../../.env');
const clickhouse = createClickHouseClient(loadEnv(clickhouseEnvSchema));
const cipher = createTestCredentialsCipher();
const NOW = new Date('2026-09-29T06:00:00.000Z');

function fakeAdapter(impl: Partial<MetaAdapter> = {}): MetaAdapter {
  return {
    provider: 'meta',
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
    fetchInsights: vi.fn().mockResolvedValue({ rows: [], truncatedByRateLimit: false }),
    ...impl,
  };
}

function spendRow(overrides: Partial<MetaInsightsResult['rows'][number]> = {}) {
  return {
    date: '2026-09-28',
    accountId: 'act_1',
    campaignId: '1',
    campaignName: 'C',
    adsetId: '2',
    adsetName: 'A',
    adId: '3',
    adName: 'Ad',
    spendPaise: 10000,
    impressions: 100,
    clicks: 10,
    platformConversions: 1,
    platformConversionValuePaise: 5000,
    attributionWindow: '7d_click+1d_view',
    ...overrides,
  };
}

const tenants: TestTenant[] = [];
async function register(label: string, accountIds: string[]) {
  const t = await seedTestTenant(label);
  tenants.push(t);
  const scope = storeBoundScope(t.storeId);
  await createIntegrationRepository(db).upsertMeta(scope, {
    storeId: t.storeId,
    externalAccountId: `biz_${t.storeId}`,
    credentialsJson: JSON.stringify({ accessToken: 'EAAtest' }),
    scopes: ['ads_read'],
    cipher,
  });
  for (const accountId of accountIds) {
    await createAdAccountRepository(db).upsert(scope, {
      storeId: t.storeId,
      provider: 'meta',
      externalId: accountId,
      name: 'x',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
    });
  }
  await createIntegrationRepository(db).patchMetaSettings(scope, t.storeId, {
    ad_account_ids: accountIds,
  });
  return t;
}

async function spendRows(storeId: string) {
  return ch(clickhouse, storeBoundScope(storeId), storeId).select<{ account_id: string }>({
    table: 'ad_spend_daily',
    columns: ['account_id'],
  });
}

afterAll(async () => {
  for (const t of tenants) {
    await clickhouse.command({
      query: 'ALTER TABLE ad_spend_daily DELETE WHERE store_id = {s:UUID}',
      query_params: { s: t.storeId },
    });
  }
  for (const t of tenants) await cleanupTestTenant(t);
  await clickhouse.close();
});

function deps(adapter: MetaAdapter, over: Partial<MetaWarmupDeps> = {}): MetaWarmupDeps {
  return { db, clickhouse, cipher, adapter, now: () => NOW, log: () => undefined, ...over };
}

describe('runMetaWarmup', () => {
  it('is a no-op for a store with no active Meta integration', async () => {
    const t = await seedTestTenant('warmup-none');
    tenants.push(t);
    const adapter = fakeAdapter();
    const result = await runMetaWarmup(deps(adapter), { storeId: t.storeId });
    expect(result).toEqual({ accounts: 0, rowsWritten: 0, callsSuccess: 0, callsError: 0 });
    expect(adapter.fetchInsights).not.toHaveBeenCalled();
  });

  it('is a no-op for a store with an integration but no registered ad accounts', async () => {
    const t = await seedTestTenant('warmup-no-accounts');
    tenants.push(t);
    await createIntegrationRepository(db).upsertMeta(storeBoundScope(t.storeId), {
      storeId: t.storeId,
      externalAccountId: 'biz_x',
      credentialsJson: '{}',
      scopes: [],
      cipher,
    });
    const adapter = fakeAdapter();
    expect(await runMetaWarmup(deps(adapter), { storeId: t.storeId })).toEqual({
      accounts: 0,
      rowsWritten: 0,
      callsSuccess: 0,
      callsError: 0,
    });
  });

  it('pulls one registered account, writes ad_spend_daily, and updates the ledger', async () => {
    const t = await register('warmup-one', ['act_1']);
    const adapter = fakeAdapter({
      fetchInsights: vi.fn().mockResolvedValue({ rows: [spendRow()], truncatedByRateLimit: false }),
    });

    const result = await runMetaWarmup(deps(adapter), { storeId: t.storeId });
    expect(result).toEqual({ accounts: 1, rowsWritten: 1, callsSuccess: 1, callsError: 0 });

    const [call] = (adapter.fetchInsights as ReturnType<typeof vi.fn>).mock.calls;
    expect(call).toEqual([{ accessToken: 'EAAtest' }, 'act_1', warmupRange('Asia/Kolkata', NOW)]);

    expect((await spendRows(t.storeId)).map((r) => r.account_id)).toEqual(['act_1']);

    const integration = await createIntegrationRepository(db).getActiveByStore(
      storeBoundScope(t.storeId),
      t.storeId,
      'meta',
    );
    expect(integration!.settings).toMatchObject({
      ad_account_ids: ['act_1'],
      warmup: { calls_total: 1, calls_success: 1, calls_error: 0, last_run_at: NOW.toISOString() },
    });
  });

  it('processes every registered account and sums the ledger across them', async () => {
    const t = await register('warmup-multi', ['act_1', 'act_2']);
    const adapter = fakeAdapter({
      fetchInsights: vi.fn().mockResolvedValue({ rows: [spendRow()], truncatedByRateLimit: false }),
    });

    const result = await runMetaWarmup(deps(adapter), { storeId: t.storeId });
    expect(result).toEqual({ accounts: 2, rowsWritten: 2, callsSuccess: 2, callsError: 0 });
    expect(adapter.fetchInsights).toHaveBeenCalledTimes(2);
  });

  it("one account's failure does not stop the others, and both are counted", async () => {
    const t = await register('warmup-partial-fail', ['act_ok', 'act_bad']);
    const adapter = fakeAdapter({
      fetchInsights: vi.fn().mockImplementation((_c, accountId) =>
        accountId === 'act_bad'
          ? Promise.reject(new Error('Meta Insights API returned 500'))
          : Promise.resolve({
              rows: [spendRow({ accountId: 'act_ok' })],
              truncatedByRateLimit: false,
            }),
      ),
    });

    const result = await runMetaWarmup(deps(adapter), { storeId: t.storeId });
    expect(result).toEqual({ accounts: 2, rowsWritten: 1, callsSuccess: 1, callsError: 1 });

    const integration = await createIntegrationRepository(db).getActiveByStore(
      storeBoundScope(t.storeId),
      t.storeId,
      'meta',
    );
    expect(integration!.settings).toMatchObject({
      warmup: { calls_total: 2, calls_success: 1, calls_error: 1, last_error_code: 'Error' },
    });
  });

  it('accumulates the ledger across runs rather than overwriting it', async () => {
    const t = await register('warmup-accumulate', ['act_1']);
    const adapter = fakeAdapter({
      fetchInsights: vi.fn().mockResolvedValue({ rows: [], truncatedByRateLimit: false }),
    });

    await runMetaWarmup(deps(adapter), { storeId: t.storeId });
    await runMetaWarmup(deps(adapter, { now: () => new Date(NOW.getTime() + 900_000) }), {
      storeId: t.storeId,
    });

    const integration = await createIntegrationRepository(db).getActiveByStore(
      storeBoundScope(t.storeId),
      t.storeId,
      'meta',
    );
    expect(integration!.settings).toMatchObject({
      warmup: { calls_total: 2, calls_success: 2, calls_error: 0 },
    });
  });

  it('never touches ad_spend_daily when the account returns no rows', async () => {
    const t = await register('warmup-empty', ['act_1']);
    const adapter = fakeAdapter();
    await runMetaWarmup(deps(adapter), { storeId: t.storeId });
    expect(await spendRows(t.storeId)).toEqual([]);
  });

  it('logs (but does not fail the call) when a page was truncated by the rate limit', async () => {
    const t = await register('warmup-truncated', ['act_1']);
    const logs: Record<string, unknown>[] = [];
    const adapter = fakeAdapter({
      fetchInsights: vi.fn().mockResolvedValue({ rows: [spendRow()], truncatedByRateLimit: true }),
    });
    const result = await runMetaWarmup(deps(adapter, { log: (l) => logs.push(l) }), {
      storeId: t.storeId,
    });
    expect(result.callsSuccess).toBe(1);
    expect(logs.some((l) => l.event === 'meta_warmup_truncated_by_rate_limit')).toBe(true);
  });

  it('never logs the error message or the credentials — name only', async () => {
    const t = await register('warmup-error-redaction', ['act_1']);
    const logs: Record<string, unknown>[] = [];
    const adapter = fakeAdapter({
      fetchInsights: vi.fn().mockRejectedValue(new Error('token EAAtest is invalid')),
    });
    await runMetaWarmup(deps(adapter, { log: (l) => logs.push(l) }), { storeId: t.storeId });
    expect(JSON.stringify(logs)).not.toContain('EAAtest');
    expect(JSON.stringify(logs)).not.toContain('is invalid');
  });
});

describe('warmupRange', () => {
  it('is yesterday…today in the given timezone', () => {
    expect(warmupRange('Asia/Kolkata', new Date('2026-09-29T01:00:00.000Z'))).toEqual({
      since: '2026-09-28', // IST is UTC+5:30, so 01:00 UTC on the 29th is 06:30 IST on the 29th
      until: '2026-09-29',
    });
  });

  it('differs across timezones for the same instant', () => {
    const now = new Date('2026-09-29T02:00:00.000Z'); // 02:00 UTC — still the 28th in New York
    expect(warmupRange('America/New_York', now).until).toBe('2026-09-28');
    expect(warmupRange('Asia/Kolkata', now).until).toBe('2026-09-29');
  });
});
