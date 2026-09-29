import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, testAuth, testDb } from '../testApp.js';
import { cleanupRealTenant, seedRealTenant, type RealTenant } from '../testAuthTenant.js';

// Basic happy-path coverage for the read-only dashboard endpoints (Integrations, Orders, Tracking,
// Privacy, Settings channel-rules, System status). Cross-tenant denial for every `:storeId` route
// here is already exercised generically by crossTenantHarness.test.ts (SPEC §5.10 test 7) — these
// tests only check that a store's own owner gets a well-shaped 200 on freshly seeded (empty) data.

const app = buildTestApp();
const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function tenant(label: string): Promise<RealTenant> {
  const t = await seedRealTenant(testAuth, testDb, label);
  cleanups.push(() => cleanupRealTenant(testDb, t));
  return t;
}

describe('dashboard read endpoints', () => {
  it('GET /v1/stores/:storeId/integrations — empty list for a freshly created store', async () => {
    const t = await tenant('dash-integrations');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/stores/${t.storeId}/integrations`,
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ integrations: [] });
  });

  it('GET /v1/stores/:storeId/orders — empty list for a freshly created store', async () => {
    const t = await tenant('dash-orders');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/stores/${t.storeId}/orders`,
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orders: [] });
  });

  it('GET /v1/stores/:storeId/orders/:orderId/journey — 404 for an order that does not exist', async () => {
    const t = await tenant('dash-journey');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/stores/${t.storeId}/orders/00000000-0000-0000-0000-000000000000/journey`,
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/stores/:storeId/tracking/summary — zeroed-out summary with no events yet', async () => {
    const t = await tenant('dash-tracking');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/stores/${t.storeId}/tracking/summary`,
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events_total).toBe(0);
    expect(body.unique_visitors).toBe(0);
    expect(body.touchpoints_by_channel).toEqual([]);
    expect(body.consent).toEqual({ accepted: 0, dropped: 0, drop_reasons: {} });
  });

  it('GET /v1/stores/:storeId/privacy/consent-stats and /privacy/requests — empty for a fresh store', async () => {
    const t = await tenant('dash-privacy');
    const stats = await app.inject({
      method: 'GET',
      url: `/v1/stores/${t.storeId}/privacy/consent-stats`,
      headers: { cookie: t.cookie },
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json()).toEqual({ suppressed_identities_count: 0, consent_records_recent: [] });

    const requests = await app.inject({
      method: 'GET',
      url: `/v1/stores/${t.storeId}/privacy/requests`,
      headers: { cookie: t.cookie },
    });
    expect(requests.statusCode).toBe(200);
    expect(requests.json().requests).toEqual([]);
  });

  it('GET /v1/stores/:storeId/channel-rules — empty list for a freshly created store', async () => {
    const t = await tenant('dash-channel-rules');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/stores/${t.storeId}/channel-rules`,
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ channel_rules: [] });
  });

  it('GET /v1/system/status — 200 for any signed-in user, 401 without a session', async () => {
    const t = await tenant('dash-system-status');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/system/status',
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().api).toBe('ok');

    const anon = await app.inject({ method: 'GET', url: '/v1/system/status' });
    expect(anon.statusCode).toBe(401);
  });
});
