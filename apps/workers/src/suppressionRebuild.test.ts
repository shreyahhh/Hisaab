import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '@truepath/db';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '@truepath/db/testing';
import { storeBoundScope, suppressionSetKey, type SuppressionSetKind } from '@truepath/shared';
import { rebuildSuppression, SuppressionRebuilder } from './suppressionRebuild.js';

// Real Postgres and durable Redis. The readiness marker is isolated per run, and every rebuild is
// limited to the stores seeded here, so nothing touches a developer's real sets or marker.

const redis = new Redis('redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  connectTimeout: 1000,
});
const readyKey = `test:${randomUUID()}:suppress:ready`;
const startedAt = new Date();

const HMAC = (n: number): string => `k1:${n.toString(16).padStart(64, '0')}`;
const FUTURE = new Date(Date.now() + 200 * 86_400_000);
const PAST = new Date(Date.now() - 86_400_000);
const epoch = (d: Date): number => Math.floor(d.getTime() / 1000);

let a: TestTenant;
let b: TestTenant;
const key = (store: TestTenant, kind: SuppressionSetKind): string =>
  suppressionSetKey(storeBoundScope(store.storeId), store.storeId, kind);
const members = (store: TestTenant, kind: SuppressionSetKind) =>
  redis.zrange(key(store, kind), 0, -1);

beforeAll(async () => {
  a = await seedTestTenant('rebuild-a');
  b = await seedTestTenant('rebuild-b');
  const row = (
    s: TestTenant,
    identifierType: 'visitor_id' | 'identity_hash_hmac',
    n: number,
    reason: 'erased' | 'withdrawn',
    expiresAt: Date,
  ) => ({ storeId: s.storeId, identifierType, identifier: HMAC(n), reason, expiresAt });
  await db.insert(schema.suppressedIdentities).values([
    row(a, 'visitor_id', 1, 'erased', FUTURE),
    row(a, 'visitor_id', 2, 'withdrawn', FUTURE),
    row(a, 'identity_hash_hmac', 3, 'erased', FUTURE),
    row(a, 'visitor_id', 4, 'erased', PAST), // expired: must not come back
    row(a, 'identity_hash_hmac', 6, 'withdrawn', FUTURE), // not a defined state: skipped
    row(b, 'visitor_id', 5, 'erased', FUTURE),
  ]);
});

afterAll(async () => {
  await redis.del(
    readyKey,
    ...(await redis.keys(`*${a.storeId}*`)),
    ...(await redis.keys(`*${b.storeId}*`)),
  );
  await cleanupTestTenant(a);
  await cleanupTestTenant(b);
  redis.disconnect();
});

const deps = (over: Record<string, unknown> = {}) => ({
  db,
  redis,
  readyKey,
  storeIds: [a.storeId, b.storeId],
  ...over,
});

const rebuiltAuditRows = async () =>
  (await db.select().from(schema.auditLog)).filter(
    (r) => r.action === 'suppression_rebuilt' && r.createdAt >= startedAt,
  );

/** A Redis whose named methods are replaced, everything else passing through. */
function withOverrides(
  base: Redis,
  overrides: Record<string, (...args: never[]) => unknown>,
): Redis {
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('rebuildSuppression', () => {
  it('reloads every active entry into its set with its expiry as the score, then sets the marker', async () => {
    // stale hot-copy content that Postgres no longer has: a rebuild replaces the set
    await redis.zadd(key(a, 'erased:visitor'), epoch(FUTURE), HMAC(999));
    await redis.del(readyKey);

    const result = await rebuildSuppression(deps());

    expect(result).toEqual({ stores: 2, entries: 4 });
    expect(await members(a, 'erased:visitor')).toEqual([HMAC(1)]); // 4 expired, 999 replaced away
    expect(await members(a, 'withdrawn:visitor')).toEqual([HMAC(2)]);
    expect(await members(a, 'erased:identity')).toEqual([HMAC(3)]);
    expect(await members(b, 'erased:visitor')).toEqual([HMAC(5)]);
    expect(Number(await redis.zscore(key(a, 'erased:visitor'), HMAC(1)))).toBe(epoch(FUTURE));
    expect(await redis.get(readyKey)).toMatch(/^\d{13}$/);
  });

  it('is repeatable and pages through Postgres (page size 2 over 4 entries)', async () => {
    await rebuildSuppression(deps({ pageSize: 2 }));
    const again = await rebuildSuppression(deps({ pageSize: 2 }));
    expect(again).toEqual({ stores: 2, entries: 4 });
    expect(await members(a, 'erased:visitor')).toEqual([HMAC(1)]);
  });

  it('writes an audited SystemScope row and a suppression_rebuilt row with counts only', async () => {
    const before = (await rebuiltAuditRows()).length;
    await rebuildSuppression(deps());

    const rows = await rebuiltAuditRows();
    expect(rows.length).toBe(before + 1);
    const latest = rows.sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0]!;
    expect(latest).toMatchObject({
      organizationId: null,
      actorType: 'system',
      metadata: { stores: 2, entries: 4 },
    });
    const scopes = (await db.select().from(schema.auditLog)).filter(
      (r) =>
        r.action === 'system_scope_used' &&
        r.targetId === 'suppression_rebuild' &&
        r.createdAt >= startedAt,
    );
    expect(scopes.length).toBeGreaterThan(0);
    expect(JSON.stringify(latest.metadata)).not.toMatch(/k\d+:/); // no hashes in audit metadata
  });

  it('does not set the marker if writing a set fails — the rebuild is retried, never half-ready', async () => {
    await redis.del(readyKey);
    const broken = withOverrides(redis, {
      multi: () => {
        const chain = {
          del: () => chain,
          zadd: () => chain,
          exec: () => Promise.reject(new Error('boom')),
        };
        return chain;
      },
    });
    await expect(rebuildSuppression(deps({ redis: broken }))).rejects.toThrow('boom');
    expect(await redis.exists(readyKey)).toBe(0);
  });

  it('writes the audit row before the marker: a failure setting the marker leaves it unset', async () => {
    await redis.del(readyKey);
    const before = (await rebuiltAuditRows()).length;
    const broken = withOverrides(redis, { set: () => Promise.reject(new Error('set failed')) });
    await expect(rebuildSuppression(deps({ redis: broken }))).rejects.toThrow('set failed');
    expect(await redis.exists(readyKey)).toBe(0);
    expect((await rebuiltAuditRows()).length).toBe(before + 1);
  });

  it('a store with no entries is untouched and reports no sets', async () => {
    const c = await seedTestTenant('rebuild-empty');
    try {
      const result = await rebuildSuppression(deps({ storeIds: [c.storeId] }));
      expect(result).toEqual({ stores: 0, entries: 0 });
      expect(await redis.exists(readyKey)).toBe(1);
    } finally {
      await cleanupTestTenant(c);
    }
  });
});

describe('SuppressionRebuilder', () => {
  function rebuilder(over: Record<string, unknown> = {}) {
    const events: Record<string, unknown>[] = [];
    const calls: string[] = [];
    let now = 1_000_000;
    const r = new SuppressionRebuilder({
      ...deps(),
      log: (l) => events.push(l),
      onUnavailable: () => void calls.push('unavailable'),
      onReady: () => void calls.push('ready'),
      nowMs: () => now,
      alertAfterMs: 60_000,
      ...over,
    });
    return { r, events, calls, advance: (ms: number) => (now += ms) };
  }

  it('does nothing while the marker is present', async () => {
    await redis.set(readyKey, '1');
    const before = (await rebuiltAuditRows()).length;
    const { r, calls } = rebuilder();
    expect(await r.tick()).toBe('ready');
    expect(calls).toEqual([]);
    expect((await rebuiltAuditRows()).length).toBe(before);
  });

  it('rebuilds when the marker is missing: pauses, rebuilds, then resumes', async () => {
    await redis.del(readyKey);
    const { r, calls, events } = rebuilder();
    expect(await r.tick()).toBe('rebuilt');
    expect(calls).toEqual(['unavailable', 'ready']);
    expect(await redis.exists(readyKey)).toBe(1);
    expect(events).toContainEqual({ event: 'suppression_rebuilt', stores: 2, entries: 4 });
  });

  it('keeps retrying a failing rebuild, stays paused, and alerts once the marker has been missing > 60 s', async () => {
    await redis.del(readyKey);
    const spy = vi.spyOn(redis, 'multi').mockImplementation((() => {
      throw new Error('redis unavailable');
    }) as never);
    try {
      const { r, calls, events, advance } = rebuilder();
      expect(await r.tick()).toBe('failed');
      expect(events.some((e) => e.alert === 'suppression_unavailable')).toBe(false);
      advance(61_000);
      expect(await r.tick()).toBe('failed');
      expect(await r.tick()).toBe('failed'); // alerts once, not on every tick
      expect(events.filter((e) => e.alert === 'suppression_unavailable')).toHaveLength(1);
      expect(events.some((e) => e.event === 'suppression_rebuild_failed')).toBe(true);
      expect(calls).toEqual(['unavailable']); // paused once, not resumed
      expect(await redis.exists(readyKey)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    // it recovers on the next tick once Redis works again
    const { r } = rebuilder();
    expect(await r.tick()).toBe('rebuilt');
  });

  it('treats an unreachable Redis as unavailable (fail closed) without crashing', async () => {
    const down = withOverrides(redis, { exists: () => Promise.reject(new Error('ECONNREFUSED')) });
    const { r, calls, events } = rebuilder({ redis: down });
    expect(await r.tick()).toBe('failed');
    expect(calls).toEqual(['unavailable']);
    expect(events).toContainEqual({ event: 'suppression_check_failed', error_name: 'Error' });
  });

  it('overlapping ticks share one run', async () => {
    await redis.del(readyKey);
    const before = (await rebuiltAuditRows()).length;
    const { r } = rebuilder();
    const [x, y] = await Promise.all([r.tick(), r.tick()]);
    expect([x, y]).toEqual(['rebuilt', 'rebuilt']);
    expect((await rebuiltAuditRows()).length).toBe(before + 1);
  });
});
