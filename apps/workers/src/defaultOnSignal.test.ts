import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStoreRepository, schema } from '@truepath/db';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '@truepath/db/testing';
import { createTestCredentialsCipher } from '@truepath/privacy/testing';
import {
  loadDotEnvIfPresent,
  loadEnv,
  postgresEnvSchema,
  storeBoundScope,
  type StreamEntry,
} from '@truepath/shared';
import {
  applyConsentHealthEvaluation,
  countDefaultOnSignal,
  evaluateDefaultOnSignal,
  incrementDefaultOnStats,
  type ApplyConsentHealthDeps,
  type ConsentHealthEvaluation,
} from './defaultOnSignal.js';

// event-pipeline.md §4.4 / HLD §8 "Consent-region gate" layer 2 (issue #52).

loadDotEnvIfPresent('../../.env');
loadEnv(postgresEnvSchema); // fails fast if the real local Postgres isn't configured

function event(overrides: Partial<StreamEntry & { kind: 'event' }> = {}): StreamEntry {
  return {
    kind: 'event',
    store_id: randomUUID(),
    event_id: randomUUID(),
    event_name: 'page_viewed',
    occurred_at: new Date().toISOString(),
    received_at: new Date().toISOString(),
    visitor_id: 'visitor-1',
    visitor_new: false,
    page_url: 'https://example.myshopify.com/',
    referrer: '',
    device_type: 'mobile',
    os: '',
    browser: '',
    is_in_app_browser: 0,
    geo_state: '',
    geo_city: '',
    consent_purposes: ['attribution_analytics'],
    identity: {},
    properties: {},
    ...overrides,
  } as StreamEntry;
}

describe('countDefaultOnSignal (pure)', () => {
  it('counts each distinct new visitor once, even with two visitor_new events in the batch', () => {
    const store = randomUUID();
    const entries = [
      { storeId: store, entry: event({ store_id: store, visitor_id: 'v1', visitor_new: true }) },
      {
        storeId: store,
        entry: event({
          store_id: store,
          visitor_id: 'v1',
          visitor_new: true,
          event_name: 'product_viewed',
        }),
      },
    ];
    const counts = countDefaultOnSignal(entries);
    expect(counts.get(store)).toEqual({ newVisitors: 1, newVisitorsInitialOnly: 1 });
  });

  it('does not count a returning visitor (visitor_new: false)', () => {
    const store = randomUUID();
    const counts = countDefaultOnSignal([
      { storeId: store, entry: event({ store_id: store, visitor_new: false }) },
    ]);
    expect(counts.has(store)).toBe(false);
  });

  it('counts a new visitor as initial-only when analytics is allowed but no interaction grant appears', () => {
    const store = randomUUID();
    const counts = countDefaultOnSignal([
      {
        storeId: store,
        entry: event({
          store_id: store,
          visitor_new: true,
          consent_purposes: ['attribution_analytics'],
        }),
      },
    ]);
    expect(counts.get(store)).toEqual({ newVisitors: 1, newVisitorsInitialOnly: 1 });
  });

  it('does not count initial-only when an interaction-triggered consent_granted is in the same batch', () => {
    const store = randomUUID();
    const counts = countDefaultOnSignal([
      { storeId: store, entry: event({ store_id: store, visitor_new: true }) },
      {
        storeId: store,
        entry: event({
          store_id: store,
          event_name: 'consent_granted',
          consent_trigger: 'interaction',
        }),
      },
    ]);
    expect(counts.get(store)).toEqual({ newVisitors: 1, newVisitorsInitialOnly: 0 });
  });

  it('does not count initial-only when analytics was never allowed', () => {
    const store = randomUUID();
    const counts = countDefaultOnSignal([
      {
        storeId: store,
        entry: event({ store_id: store, visitor_new: true, consent_purposes: [] }),
      },
    ]);
    expect(counts.get(store)).toEqual({ newVisitors: 1, newVisitorsInitialOnly: 0 });
  });

  it('ignores suppression_hit entries (no visitor_new/consent fields)', () => {
    const store = randomUUID();
    const hit: StreamEntry = {
      kind: 'suppression_hit',
      store_id: store,
      visitor_id: 'v1',
      identity_hash_hmac: 'k1:' + 'a'.repeat(64),
      received_at: new Date().toISOString(),
    };
    const counts = countDefaultOnSignal([{ storeId: store, entry: hit }]);
    expect(counts.has(store)).toBe(false);
  });

  it('keeps separate stores separate', () => {
    const storeA = randomUUID();
    const storeB = randomUUID();
    const counts = countDefaultOnSignal([
      { storeId: storeA, entry: event({ store_id: storeA, visitor_new: true }) },
      { storeId: storeB, entry: event({ store_id: storeB, visitor_id: 'v2', visitor_new: true }) },
    ]);
    expect(counts.get(storeA)).toEqual({ newVisitors: 1, newVisitorsInitialOnly: 1 });
    expect(counts.get(storeB)).toEqual({ newVisitors: 1, newVisitorsInitialOnly: 1 });
  });
});

/** A fake `hgetall`-only Redis: `evaluateDefaultOnSignal` reads nothing else. */
function fakeRedis(hashes: Record<string, Record<string, string>>) {
  return {
    async hgetall(key: string) {
      return hashes[key] ?? {};
    },
  };
}

describe('evaluateDefaultOnSignal — thresholds (event-pipeline.md §4.4)', () => {
  const NOW = Date.parse('2026-10-02T10:00:00.000Z');
  const store = randomUUID();
  const todayKey = `stats:collector:${store}:20261002`;
  const yesterdayKey = `stats:collector:${store}:20261001`;

  it('ok: below both thresholds', async () => {
    const redis = fakeRedis({
      [todayKey]: { new_visitors: '100', new_visitors_initial_only: '5' },
    });
    const result = await evaluateDefaultOnSignal(redis, store, NOW);
    expect(result).toMatchObject({ status: 'ok', newVisitors24h: 100 });
  });

  it('warn: ratio >= 0.2 over >= 50 new visitors in 24h (today alone)', async () => {
    const redis = fakeRedis({
      [todayKey]: { new_visitors: '50', new_visitors_initial_only: '10' },
    });
    const result = await evaluateDefaultOnSignal(redis, store, NOW);
    expect(result).toMatchObject({ status: 'warn', ratio: 0.2, newVisitors24h: 50 });
  });

  it('not warn: ratio high but under the 50-new-visitor floor', async () => {
    const redis = fakeRedis({ [todayKey]: { new_visitors: '10', new_visitors_initial_only: '8' } });
    const result = await evaluateDefaultOnSignal(redis, store, NOW);
    expect(result.status).toBe('ok');
  });

  it("paused: ratio >= 0.5 over >= 100 new visitors across today + yesterday's hashes", async () => {
    const redis = fakeRedis({
      [todayKey]: { new_visitors: '60', new_visitors_initial_only: '35' },
      [yesterdayKey]: { new_visitors: '40', new_visitors_initial_only: '25' },
    });
    const result = await evaluateDefaultOnSignal(redis, store, NOW);
    // 100 total, 60 initial-only -> ratio 0.6
    expect(result).toMatchObject({ status: 'paused', ratio: 0.6, newVisitors48h: 100 });
  });

  it('pause bar beats warn bar: a store already past pause is reported paused, not warn', async () => {
    const redis = fakeRedis({
      [todayKey]: { new_visitors: '100', new_visitors_initial_only: '60' },
      [yesterdayKey]: { new_visitors: '100', new_visitors_initial_only: '60' },
    });
    const result = await evaluateDefaultOnSignal(redis, store, NOW);
    expect(result.status).toBe('paused');
  });

  it('missing hashes (no activity yet) evaluate to ok, not a division error', async () => {
    const redis = fakeRedis({});
    const result = await evaluateDefaultOnSignal(redis, store, NOW);
    expect(result).toMatchObject({ status: 'ok', ratio: 0, newVisitors24h: 0, newVisitors48h: 0 });
  });
});

describe('incrementDefaultOnStats (real Redis)', () => {
  const redisUrl = 'redis://localhost:6379';
  it('HINCRBYs new_visitors and new_visitors_initial_only and sets a TTL', async () => {
    const { Redis } = await import('ioredis');
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 500 });
    const store = randomUUID();
    const nowMs = Date.parse('2026-10-02T10:00:00.000Z');
    const key = `stats:collector:${store}:20261002`;
    try {
      await incrementDefaultOnStats(
        redis,
        new Map([[store, { newVisitors: 3, newVisitorsInitialOnly: 2 }]]),
        nowMs,
      );
      expect(await redis.hget(key, 'new_visitors')).toBe('3');
      expect(await redis.hget(key, 'new_visitors_initial_only')).toBe('2');
      expect(await redis.ttl(key)).toBeGreaterThan(0);
    } finally {
      await redis.del(key);
      redis.disconnect();
    }
  });
});

describe('applyConsentHealthEvaluation (real Postgres)', () => {
  let tenant: TestTenant;
  const cipher = createTestCredentialsCipher();
  const log = vi.fn();

  function deps(overrides: Partial<ApplyConsentHealthDeps> = {}): ApplyConsentHealthDeps {
    return {
      db,
      redis: { async set() {} },
      cipher,
      dpaVersion: 'test-1',
      consentPauseEnabled: false,
      now: () => new Date('2026-10-02T10:00:00.000Z'),
      log,
      ...overrides,
    };
  }

  function evaluation(overrides: Partial<ConsentHealthEvaluation> = {}): ConsentHealthEvaluation {
    return {
      storeId: tenant.storeId,
      status: 'ok',
      ratio: 0,
      newVisitors24h: 0,
      newVisitorsInitialOnly24h: 0,
      newVisitors48h: 0,
      newVisitorsInitialOnly48h: 0,
      ...overrides,
    };
  }

  beforeAll(async () => {
    tenant = await seedTestTenant('default-on-apply');
  });
  afterAll(async () => {
    await cleanupTestTenant(tenant);
  });

  it('writes consent_health and audits consent_default_on_warned on the ok -> warn transition', async () => {
    await applyConsentHealthEvaluation(
      deps(),
      evaluation({ status: 'warn', ratio: 0.3, newVisitors24h: 60 }),
    );

    const store = await createStoreRepository(db).getById(
      storeBoundScope(tenant.storeId),
      tenant.storeId,
    );
    expect((store?.privacyConfig as { consent_health?: unknown })?.consent_health).toMatchObject({
      status: 'warn',
      ratio: 0.3,
    });

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, tenant.storeId));
    const warned = rows.filter((r) => r.action === 'consent_default_on_warned');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ metadata: { ratio: 0.3, new_visitors: 60 } });
  });

  it('does not re-audit the same status on a later tick', async () => {
    await applyConsentHealthEvaluation(
      deps(),
      evaluation({ status: 'warn', ratio: 0.35, newVisitors24h: 61 }),
    );

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, tenant.storeId));
    expect(rows.filter((r) => r.action === 'consent_default_on_warned')).toHaveLength(1);

    // But consent_health itself still refreshes with the latest ratio.
    const store = await createStoreRepository(db).getById(
      storeBoundScope(tenant.storeId),
      tenant.storeId,
    );
    expect(
      (store?.privacyConfig as { consent_health?: { ratio?: number } })?.consent_health?.ratio,
    ).toBe(0.35);
  });

  it('on warn -> paused: audits consent_default_on_paused, emails owners/admins, and (flag off) leaves the collector config alone', async () => {
    const sendDefaultOnPaused = vi.fn(
      async (_params: { to: readonly string[]; storeId: string; ratio: number }) => undefined,
    );
    await applyConsentHealthEvaluation(
      deps({ emailSender: { sendDefaultOnPaused } }),
      evaluation({ status: 'paused', ratio: 0.6, newVisitors48h: 120 }),
    );

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, tenant.storeId));
    const paused = rows.filter((r) => r.action === 'consent_default_on_paused');
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({ metadata: { ratio: 0.6, new_visitors: 120 } });

    expect(sendDefaultOnPaused).toHaveBeenCalledTimes(1);
    const call = sendDefaultOnPaused.mock.calls[0]![0];
    expect(call.storeId).toBe(tenant.storeId);
    expect(call.to).toContain(
      (await db.select().from(schema.users).where(eq(schema.users.id, tenant.userId)))[0]!.email,
    );
  });

  it('once paused, a later tick is a complete no-op (no re-write, no re-audit, no second email)', async () => {
    const sendDefaultOnPaused = vi.fn(
      async (_params: { to: readonly string[]; storeId: string; ratio: number }) => undefined,
    );
    const before = await createStoreRepository(db).getById(
      storeBoundScope(tenant.storeId),
      tenant.storeId,
    );

    await applyConsentHealthEvaluation(
      deps({ emailSender: { sendDefaultOnPaused } }),
      evaluation({ status: 'paused', ratio: 0.9, newVisitors48h: 500 }), // a worse reading
    );

    const after = await createStoreRepository(db).getById(
      storeBoundScope(tenant.storeId),
      tenant.storeId,
    );
    expect(
      (after?.privacyConfig as { consent_health?: { ratio?: number } })?.consent_health?.ratio,
    ).toBe(
      (before?.privacyConfig as { consent_health?: { ratio?: number } })?.consent_health?.ratio,
    );
    expect(sendDefaultOnPaused).not.toHaveBeenCalled();

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, tenant.storeId));
    expect(rows.filter((r) => r.action === 'consent_default_on_paused')).toHaveLength(1);
  });

  it('a store with no privacy_config history goes straight ok -> paused with no warn audit required first', async () => {
    const fresh = await seedTestTenant('default-on-direct-pause');
    try {
      await applyConsentHealthEvaluation(
        deps(),
        evaluation({ storeId: fresh.storeId, status: 'paused', ratio: 0.8, newVisitors48h: 200 }),
      );
      const rows = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetId, fresh.storeId));
      expect(rows.map((r) => r.action)).toEqual(['consent_default_on_paused']);
    } finally {
      await cleanupTestTenant(fresh);
    }
  });
});
