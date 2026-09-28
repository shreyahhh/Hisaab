import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ch, createClickHouseClient } from '@truepath/clickhouse';
import { schema } from '@truepath/db';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '@truepath/db/testing';
import { storeContext } from '@truepath/privacy';
import { createTestIdentityHasher } from '@truepath/privacy/testing';
import {
  clickhouseEnvSchema,
  loadDotEnvIfPresent,
  loadEnv,
  storeBoundScope,
  suppressionSetKey,
  uuidV7,
  type StreamEventEntry,
} from '@truepath/shared';
import { processEventBatch, type EventBatchDeps } from './eventBatch.js';
import { EventConsumer } from './eventConsumer.js';
import { SuppressionNotReadyError } from './eventSuppression.js';
import { StoreContextCache } from './storeEventContext.js';
import type { RawStreamEntry } from './streamEntries.js';

// End-to-end tests for the event pipeline against the real local Postgres, ClickHouse and durable Redis
// (like every other integration test here). The global names — the readiness marker and the three
// streams — are isolated per run, so nothing here can touch a developer's real pipeline; every
// per-store key is namespaced by a freshly seeded store id and removed afterwards.

loadDotEnvIfPresent('../../.env');
const clickhouse = createClickHouseClient(loadEnv(clickhouseEnvSchema));
const redis = new Redis('redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  connectTimeout: 1000,
});
const reader = redis.duplicate();
const hasher = createTestIdentityHasher();

const runId = randomUUID();
const readyKey = `test:${runId}:suppress:ready`;
const stream = `test:${runId}:stream`;
const deadStream = `test:${runId}:dead`;
const group = 'event-workers';

let tenant: TestTenant;
let shopHost: string;
const storeId = (): string => tenant.storeId;

const dsrAdd = vi.fn(async (..._args: unknown[]) => ({}) as never);
const dsrQueue = { add: dsrAdd } as unknown as EventBatchDeps['dsrQueue'];

function deps(overrides: Partial<EventBatchDeps> = {}): EventBatchDeps {
  return {
    redis,
    clickhouse,
    db,
    hasher,
    dsrQueue,
    stores: new StoreContextCache(db),
    readyKey,
    now: () => new Date(),
    newSessionId: () => uuidV7(Date.now(), randomBytes(16)),
    ...overrides,
  };
}

let counter = 0;
const T_BASE = Date.now() - 3 * 3600_000;
const at = (minutes: number): string => new Date(T_BASE + minutes * 60_000).toISOString();

function ev(
  name: StreamEventEntry['event_name'],
  minutes: number,
  overrides: Partial<StreamEventEntry> = {},
): StreamEventEntry {
  return {
    kind: 'event',
    store_id: storeId(),
    event_id: randomUUID(),
    event_name: name,
    occurred_at: at(minutes),
    received_at: at(minutes),
    visitor_id: 'visitor-A',
    visitor_new: false,
    page_url: `https://${shopHost}/products/tee`,
    referrer: '',
    device_type: 'mobile',
    os: 'Android',
    browser: 'Chrome',
    is_in_app_browser: 0,
    geo_state: '',
    geo_city: '',
    consent_purposes: ['attribution_analytics'],
    identity: {},
    properties: {},
    ...overrides,
  };
}

function raw(entry: { store_id: string } & Record<string, unknown>): RawStreamEntry {
  counter += 1;
  return {
    id: `${Date.now()}-${counter}`,
    fields: { store_id: entry.store_id, payload: JSON.stringify(entry) },
  };
}

const visitorHmac = (visitor: string, store = storeId()): string =>
  hasher.hmac(storeContext(store), visitor);
const zscore = (kind: 'erased:visitor' | 'erased:identity' | 'withdrawn:visitor', member: string) =>
  redis.zscore(suppressionSetKey(storeBoundScope(storeId()), storeId(), kind), member);

async function chRows<T extends Record<string, unknown>>(
  table: 'events' | 'touchpoints' | 'identity_links',
  columns: string[],
): Promise<T[]> {
  return ch(clickhouse, storeBoundScope(storeId()), storeId()).select<T>({ table, columns });
}

async function waitFor(check: () => Promise<boolean>, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor: condition not met in time');
}

beforeAll(async () => {
  tenant = await seedTestTenant('pipeline');
  shopHost = (await db.select().from(schema.stores)).find(
    (s) => s.id === tenant.storeId,
  )!.shopDomain;
  await redis.set(readyKey, String(Date.now()));
});

afterAll(async () => {
  const keys = await redis.keys(`*${tenant.storeId}*`);
  await redis.del(readyKey, stream, deadStream, ...keys);
  for (const table of ['events', 'touchpoints', 'identity_links']) {
    await clickhouse.command({
      query: `ALTER TABLE ${table} DELETE WHERE store_id = {s:UUID}`,
      query_params: { s: tenant.storeId },
    });
  }
  await cleanupTestTenant(tenant);
  reader.disconnect();
  redis.disconnect();
  await clickhouse.close();
});

describe('processEventBatch', () => {
  it('fails closed without suppress:ready: throws and writes nothing', async () => {
    const e = ev('page_viewed', 0);
    const missing = `${readyKey}:absent`;
    await expect(processEventBatch(deps({ readyKey: missing }), [raw(e)])).rejects.toThrow(
      SuppressionNotReadyError,
    );
    expect(await chRows('events', ['event_id'])).toEqual([]);
  });

  it('writes the event and a classified touchpoint, sets the dedupe key, and acks', async () => {
    const e = ev('page_viewed', 0, {
      visitor_id: 'visitor-happy',
      page_url: `https://${shopHost}/products/tee?utm_source=facebook&utm_medium=paid_social&utm_campaign=120&utm_content=121&utm_term=122&fbclid=AbC`,
      referrer: 'https://l.instagram.com/',
      consent_purposes: ['attribution_analytics', 'ad_platform_measurement'],
    });
    const r = raw(e);
    const result = await processEventBatch(deps(), [r]);

    expect(result.ackIds).toEqual([r.id]);
    expect(result.counts).toMatchObject({ written: 1, touchpoints: 1, invalid: 0 });

    const [row] = (
      await chRows<Record<string, unknown>>('events', [
        'event_id',
        'session_id',
        'visitor_id',
        'utm_source',
        'utm_campaign',
        'fbclid',
        'fbc',
        'consent_purposes',
      ])
    ).filter((x) => x.event_id === e.event_id);
    expect(row).toMatchObject({
      visitor_id: 'visitor-happy',
      utm_source: 'facebook',
      utm_campaign: '120',
      fbclid: 'AbC',
      consent_purposes: ['attribution_analytics', 'ad_platform_measurement'],
    });
    // built from fbclid + the event time, because this visitor consented to ad-platform measurement
    expect(String(row!.fbc)).toMatch(/^fb\.1\.\d{13}\.AbC$/);

    const [tp] = (
      await chRows<Record<string, unknown>>('touchpoints', [
        'event_id',
        'session_id',
        'channel',
        'platform',
        'campaign_id',
        'adset_id',
        'ad_id',
        'click_id_type',
        'is_direct',
      ])
    ).filter((x) => x.event_id === e.event_id);
    expect(tp).toMatchObject({
      session_id: row!.session_id,
      channel: 'meta_ads',
      platform: 'meta',
      campaign_id: '120',
      adset_id: '121',
      ad_id: '122',
      click_id_type: 'fbclid',
      is_direct: 0,
    });
    expect(await redis.get(`dedupe:${storeId()}:${e.event_id}`)).toBe('done');
  });

  it('does not derive an fbc for a visitor without ad-platform consent', async () => {
    const e = ev('page_viewed', 1, {
      visitor_id: 'visitor-noads',
      page_url: `https://${shopHost}/?fbclid=Zzz`,
    });
    await processEventBatch(deps(), [raw(e)]);
    const [row] = (
      await chRows<{ event_id: string; fbc: string }>('events', ['event_id', 'fbc'])
    ).filter((x) => x.event_id === e.event_id);
    expect(row!.fbc).toBe('');
  });

  it('a redelivered event is acknowledged without a second write (dedupe)', async () => {
    const e = ev('page_viewed', 2, { visitor_id: 'visitor-dup' });
    const r = raw(e);
    await processEventBatch(deps(), [r]);
    const again = await processEventBatch(deps(), [r]);

    expect(again.ackIds).toEqual([r.id]);
    expect(again.counts.dropped.duplicate).toBe(1);
    expect(again.counts.written).toBe(0);
    const mine = (await chRows<{ event_id: string }>('events', ['event_id'])).filter(
      (x) => x.event_id === e.event_id,
    );
    expect(mine).toHaveLength(1);
  });

  it('sessionises per visitor: one touchpoint per session, a new one after 30 minutes idle', async () => {
    const v = 'visitor-sessions';
    const a = ev('page_viewed', 10, { visitor_id: v });
    const b = ev('product_viewed', 20, { visitor_id: v, properties: { product_id: 'p1' } });
    const c = ev('page_viewed', 51, { visitor_id: v }); // 31 minutes after b
    // arrival order deliberately not chronological
    await processEventBatch(deps(), [raw(c), raw(a), raw(b)]);

    const events = (
      await chRows<{ event_id: string; session_id: string; visitor_id: string }>('events', [
        'event_id',
        'session_id',
        'visitor_id',
      ])
    ).filter((x) => x.visitor_id === v);
    const sessionOf = (id: string) => events.find((x) => x.event_id === id)!.session_id;
    expect(sessionOf(a.event_id)).toBe(sessionOf(b.event_id));
    expect(sessionOf(c.event_id)).not.toBe(sessionOf(a.event_id));

    const tps = (
      await chRows<{ event_id: string; visitor_id: string; channel: string }>('touchpoints', [
        'event_id',
        'visitor_id',
        'channel',
      ])
    ).filter((x) => x.visitor_id === v);
    expect(tps.map((t) => t.event_id).sort()).toEqual([a.event_id, c.event_id].sort());
    expect(tps.every((t) => t.channel === 'direct')).toBe(true);
  });

  it("a referrer on the shop's own host is not a referral", async () => {
    const e = ev('page_viewed', 60, {
      visitor_id: 'visitor-own',
      referrer: `https://${shopHost}/cart`,
    });
    await processEventBatch(deps(), [raw(e)]);
    const [tp] = (
      await chRows<{ event_id: string; channel: string }>('touchpoints', ['event_id', 'channel'])
    ).filter((x) => x.event_id === e.event_id);
    expect(tp!.channel).toBe('direct');
  });

  it('checkout events write identity links, the checkout key and orders.visitor_id', async () => {
    await db.insert(schema.orders).values({
      storeId: storeId(),
      externalOrderId: '7001',
      createdAtPlatform: new Date(),
      totalAmountPaise: 129900,
      currency: 'INR',
      paymentMethod: 'cod',
    });
    const phone = hasher.hmac(storeContext(storeId()), '+919876543210');
    const email = hasher.hmac(storeContext(storeId()), 'a@example.com');
    const e = ev('checkout_completed', 70, {
      visitor_id: 'visitor-buyer',
      identity: { phone_hmac: phone, email_hmac: email, identity_hash_hmac: phone },
      properties: { checkout_token: 'tok', order_id: '7001', total_amount_paise: 129900 },
    });
    const result = await processEventBatch(deps(), [raw(e)]);

    expect(result.counts.ordersLinked).toBe(1);
    const links = (
      await chRows<{ visitor_id: string; identity_hash_hmac: string }>('identity_links', [
        'visitor_id',
        'identity_hash_hmac',
      ])
    ).filter((x) => x.visitor_id === 'visitor-buyer');
    expect(links.map((l) => l.identity_hash_hmac).sort()).toEqual([email, phone].sort());
    expect(await redis.get(`checkout:${storeId()}:7001`)).toBe('visitor-buyer');
    const order = (await db.select().from(schema.orders)).find(
      (o) => o.storeId === storeId() && o.externalOrderId === '7001',
    );
    expect(order!.visitorId).toBe('visitor-buyer');
    // no raw contact anywhere in what was stored
    const stored = JSON.stringify(
      (await chRows('events', ['properties', 'identity_hash_hmac'])).filter(() => true),
    );
    expect(stored).not.toMatch(/@|\+91/);
  });

  it('drops events of an erased visitor and of a withdrawn visitor, but never a consent event of a withdrawn one', async () => {
    const erased = 'visitor-erased';
    const withdrawn = 'visitor-withdrawn';
    const future = Math.floor(Date.now() / 1000) + 10_000;
    await redis.zadd(
      suppressionSetKey(storeBoundScope(storeId()), storeId(), 'erased:visitor'),
      future,
      visitorHmac(erased),
    );
    await redis.zadd(
      suppressionSetKey(storeBoundScope(storeId()), storeId(), 'withdrawn:visitor'),
      future,
      visitorHmac(withdrawn),
    );

    const a = raw(ev('page_viewed', 80, { visitor_id: erased }));
    const b = raw(ev('page_viewed', 80, { visitor_id: withdrawn }));
    const consent = ev('consent_granted', 81, {
      visitor_id: withdrawn,
      consent_trigger: 'interaction',
      notice_version: 'v3',
    });
    const c = raw(consent);
    const result = await processEventBatch(deps(), [a, b, c]);

    expect(result.counts.dropped.suppressed_visitor).toBe(2);
    expect(result.counts.written).toBe(1); // only the withdrawn visitor's consent event
    expect([...result.ackIds].sort()).toEqual([a.id, b.id, c.id].sort());
    const stored = (await chRows<{ visitor_id: string }>('events', ['visitor_id'])).map(
      (x) => x.visitor_id,
    );
    expect(stored).not.toContain(erased);
    expect(stored.filter((v) => v === withdrawn)).toHaveLength(1);
  });

  it('an expired suppression entry no longer suppresses', async () => {
    const v = 'visitor-expired';
    await redis.zadd(
      suppressionSetKey(storeBoundScope(storeId()), storeId(), 'erased:visitor'),
      Math.floor(Date.now() / 1000) - 10,
      visitorHmac(v),
    );
    const e = ev('page_viewed', 82, { visitor_id: v });
    expect((await processEventBatch(deps(), [raw(e)])).counts.written).toBe(1);
  });

  it('consent: records evidence with the notice version and source; no touchpoint; a granted then withdrawn visitor is erased and suppressed', async () => {
    dsrAdd.mockClear();
    const v = 'visitor-consent';
    const granted = ev('consent_granted', 90, {
      visitor_id: v,
      consent_trigger: 'initial_state',
      notice_version: 'v7',
    });
    await processEventBatch(deps(), [raw(granted)]);
    let records = (await db.select().from(schema.consentRecords)).filter(
      (r) => r.id === granted.event_id,
    );
    expect(records).toMatchObject([
      {
        storeId: storeId(),
        visitorId: visitorHmac(v),
        state: 'granted',
        noticeVersion: 'v7',
        source: 'pixel_initial_state',
        purposes: ['attribution_analytics'],
      },
    ]);
    // a consent event is evidence, not a landing: no touchpoint
    expect(
      (await chRows<{ event_id: string }>('touchpoints', ['event_id'])).some(
        (t) => t.event_id === granted.event_id,
      ),
    ).toBe(false);

    const withdrawn = ev('consent_withdrawn', 91, {
      visitor_id: v,
      notice_version: 'v7',
      consent_purposes: [],
    });
    const result = await processEventBatch(deps(), [raw(withdrawn)]);
    expect(result.counts.withdrawals).toBe(1);

    records = (await db.select().from(schema.consentRecords)).filter(
      (r) => r.id === withdrawn.event_id,
    );
    expect(records).toMatchObject([{ state: 'withdrawn', source: 'pixel_interaction' }]);

    const suppression = (await db.select().from(schema.suppressedIdentities)).filter(
      (s) => s.storeId === storeId() && s.identifier === visitorHmac(v),
    );
    expect(suppression).toMatchObject([{ reason: 'withdrawn', identifierType: 'visitor_id' }]);
    expect(Number(await zscore('withdrawn:visitor', visitorHmac(v)))).toBeGreaterThan(
      Date.now() / 1000,
    );

    const requestId = suppression[0]!.dsrRequestId!;
    const [request] = (await db.select().from(schema.dsrRequests)).filter(
      (r) => r.id === requestId,
    );
    expect(request).toMatchObject({
      type: 'erasure',
      identityHash: visitorHmac(v),
      resultSummary: { trigger: 'consent_withdrawn' },
    });
    expect(dsrAdd).toHaveBeenCalledWith(
      'erasure',
      { storeId: storeId(), type: 'erasure', requestId },
      { jobId: `dsr-${requestId}`, delay: 60_000 },
    );

    // the next page view of that visitor is dropped at the re-check
    const later = await processEventBatch(deps(), [raw(ev('page_viewed', 92, { visitor_id: v }))]);
    expect(later.counts.dropped.suppressed_visitor).toBe(1);

    // re-consent lifts the withdrawn entry (Postgres and Redis); tracking resumes
    const regrant = ev('consent_granted', 93, {
      visitor_id: v,
      consent_trigger: 'interaction',
      notice_version: 'v7',
    });
    await processEventBatch(deps(), [raw(regrant)]);
    expect(await zscore('withdrawn:visitor', visitorHmac(v))).toBeNull();
    expect(
      (await db.select().from(schema.suppressedIdentities)).filter(
        (s) => s.storeId === storeId() && s.identifier === visitorHmac(v),
      ),
    ).toEqual([]);
    expect(
      (await processEventBatch(deps(), [raw(ev('page_viewed', 94, { visitor_id: v }))])).counts
        .written,
    ).toBe(1);
  });

  it('a page view after a withdrawal in the same batch is not stored; a marketing-only grant does not lift a withdrawal', async () => {
    const v = 'visitor-samebatch';
    const withdraw = ev('consent_withdrawn', 100, {
      visitor_id: v,
      notice_version: 'v1',
      consent_purposes: [],
    });
    const after = ev('page_viewed', 101, { visitor_id: v });
    const before = ev('page_viewed', 99, { visitor_id: v });
    const result = await processEventBatch(deps(), [raw(after), raw(withdraw), raw(before)]);
    expect(result.counts.written).toBe(2); // the withdrawal and the earlier page view (erased later by the DSR job)
    expect(result.counts.dropped.suppressed_visitor).toBe(1);

    const marketingOnly = ev('consent_granted', 102, {
      visitor_id: v,
      consent_trigger: 'interaction',
      notice_version: 'v1',
      consent_purposes: ['ad_platform_measurement'],
    });
    await processEventBatch(deps(), [raw(marketingOnly)]);
    expect(Number(await zscore('withdrawn:visitor', visitorHmac(v)))).toBeGreaterThan(0);
  });

  it('a suppression hit from the Collector erases the new visitor and enqueues the follow-up purge', async () => {
    dsrAdd.mockClear();
    const [erasure] = await db
      .insert(schema.dsrRequests)
      .values({ storeId: storeId(), type: 'erasure', identityHash: 'k1:x', dueAt: new Date() })
      .returning({ id: schema.dsrRequests.id });
    const identity = hasher.hmac(storeContext(storeId()), '+919000012345');
    await db.insert(schema.suppressedIdentities).values({
      storeId: storeId(),
      identifierType: 'identity_hash_hmac',
      identifier: identity,
      reason: 'erased',
      dsrRequestId: erasure!.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const hit = raw({
      kind: 'suppression_hit',
      store_id: storeId(),
      visitor_id: 'visitor-newdevice',
      identity_hash_hmac: identity,
      received_at: at(110),
    });
    // an earlier page view of that device, in the same batch
    const early = raw(ev('page_viewed', 109, { visitor_id: 'visitor-newdevice' }));
    const result = await processEventBatch(deps(), [early, hit]);

    expect([...result.ackIds].sort()).toEqual([early.id, hit.id].sort());
    expect(result.counts).toMatchObject({ suppressionHits: 1, written: 0 });
    expect(
      Number(await zscore('erased:visitor', visitorHmac('visitor-newdevice'))),
    ).toBeGreaterThan(0);
    const [suppression] = (await db.select().from(schema.suppressedIdentities)).filter(
      (s) => s.storeId === storeId() && s.identifier === visitorHmac('visitor-newdevice'),
    );
    expect(suppression).toMatchObject({ reason: 'erased', dsrRequestId: erasure!.id });
    expect(dsrAdd).toHaveBeenCalledWith(
      'erasure',
      {
        storeId: storeId(),
        type: 'erasure',
        requestId: erasure!.id,
        visitorIds: ['visitor-newdevice'],
      },
      { jobId: `dsr-followup-${erasure!.id}-${suppression!.id}` },
    );
    expect(
      (await chRows<{ visitor_id: string }>('events', ['visitor_id'])).some(
        (x) => x.visitor_id === 'visitor-newdevice',
      ),
    ).toBe(false);
  });

  it("an erased identity that shows up after the Collector's check is caught by the worker's own re-check", async () => {
    dsrAdd.mockClear();
    const identity = hasher.hmac(storeContext(storeId()), '+919000054321');
    const [erasure] = await db
      .insert(schema.dsrRequests)
      .values({ storeId: storeId(), type: 'erasure', identityHash: identity, dueAt: new Date() })
      .returning({ id: schema.dsrRequests.id });
    await db.insert(schema.suppressedIdentities).values({
      storeId: storeId(),
      identifierType: 'identity_hash_hmac',
      identifier: identity,
      reason: 'erased',
      dsrRequestId: erasure!.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await redis.zadd(
      suppressionSetKey(storeBoundScope(storeId()), storeId(), 'erased:identity'),
      Math.floor(Date.now() / 1000) + 10_000,
      identity,
    );

    const v = 'visitor-late-identity';
    const contact = ev('checkout_contact_info_submitted', 120, {
      visitor_id: v,
      identity: { phone_hmac: identity, identity_hash_hmac: identity },
      properties: { checkout_token: 't' },
    });
    const page = ev('page_viewed', 121, { visitor_id: v });
    const result = await processEventBatch(deps(), [raw(contact), raw(page)]);

    expect(result.counts).toMatchObject({ written: 0, suppressionHits: 1 });
    expect(result.counts.dropped.suppressed_identity).toBe(2);
    expect(Number(await zscore('erased:visitor', visitorHmac(v)))).toBeGreaterThan(0);
    expect(dsrAdd).toHaveBeenCalledTimes(1);
  });

  it('acknowledges and drops entries of a store that does not exist', async () => {
    const ghost = ev('page_viewed', 130, { store_id: randomUUID() });
    const r = raw(ghost);
    const result = await processEventBatch(deps(), [r]);
    expect(result.ackIds).toEqual([r.id]);
    expect(result.counts.dropped.unknown_store).toBe(1);
  });

  it('leaves an entry that does not validate un-acknowledged', async () => {
    const good = raw(ev('page_viewed', 131, { visitor_id: 'visitor-good' }));
    const bad: RawStreamEntry = {
      id: '1-1',
      fields: { store_id: storeId(), payload: '{"kind":"event"}' },
    };
    const mismatch: RawStreamEntry = {
      id: '1-2',
      fields: { store_id: randomUUID(), payload: good.fields.payload! },
    };
    const result = await processEventBatch(deps(), [bad, good, mismatch]);
    expect(result.ackIds).toEqual([good.id]);
    expect(result.counts.invalid).toBe(2);
  });

  it('a retry after a failed enqueue re-uses session ids and still enqueues the erasure job', async () => {
    dsrAdd.mockClear();
    const v = 'visitor-retry';
    const page = ev('page_viewed', 140, { visitor_id: v });
    const later = ev('page_viewed', 175, { visitor_id: v }); // 35 min later: a second session
    const withdraw = ev('consent_withdrawn', 176, {
      visitor_id: v,
      notice_version: 'v1',
      consent_purposes: [],
    });
    const batch = [raw(page), raw(later), raw(withdraw)];
    const memo = new Map();

    dsrAdd.mockRejectedValueOnce(new Error('redis down'));
    await expect(processEventBatch(deps(), batch, memo)).rejects.toThrow('redis down');
    // nothing was marked done, so a redelivery could not skip the withdrawal
    expect(await redis.exists(`dedupe:${storeId()}:${withdraw.event_id}`)).toBe(0);

    const retry = await processEventBatch(deps(), batch, memo);
    expect(retry.counts.written).toBe(3);
    expect(dsrAdd).toHaveBeenCalledTimes(2); // the failed attempt, then the retry (same jobId)
    expect(dsrAdd.mock.calls[0]![2]).toEqual(dsrAdd.mock.calls[1]![2]);

    // ClickHouse holds each event's session as first assigned, despite the second pass
    const events = (
      await chRows<{ event_id: string; session_id: string }>('events', ['event_id', 'session_id'])
    ).filter((x) => [page.event_id, later.event_id].includes(x.event_id));
    const sessions = new Map<string, Set<string>>();
    for (const x of events)
      sessions.set(x.event_id, (sessions.get(x.event_id) ?? new Set()).add(x.session_id));
    expect([...sessions.values()].every((s) => s.size === 1)).toBe(true);
  });
});

describe('EventConsumer', () => {
  function consumer(name: string, over: Record<string, unknown> = {}) {
    return new EventConsumer(
      {
        reader,
        redis,
        process: (entries, memo) => processEventBatch(deps(), entries, memo),
        log: () => undefined,
      },
      {
        consumer: name,
        stream,
        group,
        deadStream,
        flushMs: 50,
        blockMs: 50,
        reclaimEveryMs: 3_600_000,
        ...over,
      },
    );
  }
  const xadd = (entry: object & { store_id: string }) =>
    redis.xadd(stream, '*', 'store_id', entry.store_id, 'payload', JSON.stringify(entry));
  const pendingCount = async (): Promise<number> =>
    Number(((await redis.xpending(stream, group)) as unknown[])[0]);

  it('reads the stream through the group, writes, and acknowledges', async () => {
    const c = consumer('c1');
    await c.ensureGroup();
    const e1 = ev('page_viewed', 150, { visitor_id: 'visitor-loop' });
    const e2 = ev('product_viewed', 151, {
      visitor_id: 'visitor-loop',
      properties: { product_id: 'p' },
    });
    await xadd(e1);
    await xadd(e2);

    const running = c.run();
    await waitFor(async () => {
      const rows = await chRows<{ event_id: string }>('events', ['event_id']);
      return (
        [e1, e2].every((e) => rows.some((r) => r.event_id === e.event_id)) &&
        (await pendingCount()) === 0
      );
    });
    c.stop();
    await running;
  });

  it('a batch waits, without acknowledging, while suppress:ready is missing, then completes', async () => {
    const logs: Record<string, unknown>[] = [];
    const key = `${readyKey}:late`;
    const c = new EventConsumer(
      {
        reader,
        redis,
        process: (entries, memo) => processEventBatch(deps({ readyKey: key }), entries, memo),
        log: (l) => logs.push(l),
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
      },
      {
        consumer: 'c-notready',
        stream,
        group,
        deadStream,
        flushMs: 20,
        blockMs: 50,
        reclaimEveryMs: 3_600_000,
      },
    );
    const e = ev('page_viewed', 160, { visitor_id: 'visitor-late' });
    await xadd(e);
    const running = c.run();
    await waitFor(async () => logs.some((l) => l.event === 'event_pipeline_paused'));
    expect(
      (await chRows<{ event_id: string }>('events', ['event_id'])).some(
        (r) => r.event_id === e.event_id,
      ),
    ).toBe(false);
    await redis.set(key, '1');
    await waitFor(async () =>
      (await chRows<{ event_id: string }>('events', ['event_id'])).some(
        (r) => r.event_id === e.event_id,
      ),
    );
    c.stop();
    await running;
    await redis.del(key);
  });

  it('reclaims entries a crashed consumer left pending, and processes them', async () => {
    const c = consumer('c-recover', { minIdleMs: 0 });
    await c.ensureGroup();
    const e = ev('page_viewed', 170, { visitor_id: 'visitor-crash' });
    await xadd(e);
    // a consumer that read the entry and died before acking
    const got = (await reader.xreadgroup(
      'GROUP',
      group,
      'c-crashed',
      'COUNT',
      10,
      'STREAMS',
      stream,
      '>',
    )) as [string, [string, string[]][]][] | null;
    expect(got?.[0]?.[1]).toHaveLength(1);

    const claimed = await c.reclaim();
    expect(claimed).toHaveLength(1);
    await c.flush(claimed, 'test');
    expect(
      (await chRows<{ event_id: string }>('events', ['event_id'])).some(
        (r) => r.event_id === e.event_id,
      ),
    ).toBe(true);
    expect(await pendingCount()).toBe(0);
  });

  it('dead-letters an entry delivered too many times, then acknowledges it', async () => {
    const c = consumer('c-poison', { minIdleMs: 0, poisonDeliveries: 2 });
    await c.ensureGroup();
    const id = (await redis.xadd(
      stream,
      '*',
      'store_id',
      storeId(),
      'payload',
      '{"kind":"event"}',
    )) as string;
    await reader.xreadgroup('GROUP', group, 'c-poison', 'COUNT', 10, 'STREAMS', stream, '>'); // delivery 1

    const claimed = await c.reclaim(); // XAUTOCLAIM makes it delivery 2 → poison
    expect(claimed.find((x) => x.id === id)).toBeUndefined();
    const dead = await redis.xrange(deadStream, '-', '+');
    expect(dead).toHaveLength(1);
    const fields = Object.fromEntries(
      dead[0]![1].reduce<[string, string][]>(
        (acc, _, i, a) => (i % 2 === 0 ? [...acc, [a[i]!, a[i + 1]!]] : acc),
        [],
      ),
    );
    expect(fields).toMatchObject({
      reason: 'delivery_limit',
      source_id: id,
      store_id: storeId(),
      payload: '{"kind":"event"}',
    });
    expect(await pendingCount()).toBe(0);
  });

  it('leaves an entry alone while this consumer is processing it', async () => {
    const c = consumer('c-inflight', { minIdleMs: 0, poisonDeliveries: 1 });
    await c.ensureGroup();
    const e = ev('page_viewed', 180, { visitor_id: 'visitor-inflight' });
    const id = (await xadd(e)) as string;
    const [reply] = (await reader.xreadgroup(
      'GROUP',
      group,
      'c-inflight',
      'COUNT',
      10,
      'STREAMS',
      stream,
      '>',
    )) as [string, [string, string[]][]][];
    expect(reply![1][0]![0]).toBe(id);

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slow = new EventConsumer(
      {
        reader,
        redis,
        process: async (entries, memo) => {
          await held;
          return processEventBatch(deps(), entries, memo);
        },
        log: () => undefined,
      },
      { consumer: 'c-inflight', stream, group, deadStream, minIdleMs: 0, poisonDeliveries: 1 },
    );
    const flushing = slow.flush(
      [{ id, fields: { store_id: e.store_id, payload: JSON.stringify(e) } }],
      'test',
    );
    expect(await slow.reclaim()).toEqual([]); // not re-claimed, not dead-lettered, although "poison" by count
    expect(await redis.xlen(deadStream)).toBe(1); // only the earlier test's entry
    release();
    await flushing;
    expect(await pendingCount()).toBe(0);
  });
});
