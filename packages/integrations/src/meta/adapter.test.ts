import { afterEach, describe, expect, it, vi } from 'vitest';
import { RATE_LIMIT_PAUSE_MS } from './rateLimit.js';
import { createMetaAdapter, META_API_VERSION } from './adapter.js';

const creds = { accessToken: 'EAAtest' };
const range = { since: '2026-09-27', until: '2026-09-28' };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    date_start: '2026-09-28',
    campaign_id: '1',
    campaign_name: 'C',
    adset_id: '2',
    adset_name: 'A',
    ad_id: '3',
    ad_name: 'Ad',
    spend: '100.00',
    impressions: '10',
    clicks: '1',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createMetaAdapter — fetchInsights', () => {
  it('calls the pinned API version with level=ad, time_increment=1 and the documented fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await createMetaAdapter().fetchInsights(creds, 'act_123', range);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(
      `https://graph.facebook.com/${META_API_VERSION}/act_123/insights?`,
    );
    expect(String(url)).toContain('level=ad');
    expect(String(url)).toContain('time_increment=1');
    expect(String(url)).toContain(
      encodeURIComponent('{"since":"2026-09-27","until":"2026-09-28"}'),
    );
    expect(String(url)).toContain(encodeURIComponent(JSON.stringify(['7d_click', '1d_view'])));
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe(
      'Bearer EAAtest',
    );
  });

  it('maps every row and fills in the account id the caller asked for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { data: [row(), row({ ad_id: '4' })] })),
    );
    const result = await createMetaAdapter().fetchInsights(creds, 'act_123', range);
    expect(result).toEqual({
      rows: [
        expect.objectContaining({ accountId: 'act_123', adId: '3', spendPaise: 10000 }),
        expect.objectContaining({ accountId: 'act_123', adId: '4' }),
      ],
      truncatedByRateLimit: false,
    });
  });

  it('pages until paging.cursors.after is absent, using the cursor for the next request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [row({ ad_id: '1' })],
          paging: { cursors: { after: 'CURSOR1' } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: [row({ ad_id: '2' })] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createMetaAdapter().fetchInsights(creds, 'act_123', range);
    expect(result.rows.map((r) => r.adId)).toEqual(['1', '2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toContain('after=CURSOR1');
  });

  it('pauses (RATE_LIMIT_PAUSE_MS) between pages when the usage header is at or above threshold, then continues', async () => {
    const usage = JSON.stringify({
      act_123: [
        { call_count: 80, total_cputime: 1, total_time: 1, estimated_time_to_regain_access: 0 },
      ],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          { data: [row()], paging: { cursors: { after: 'CURSOR1' } } },
          { 'x-business-use-case-usage': usage },
        ),
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: [row()] }));
    vi.stubGlobal('fetch', fetchMock);
    const sleeps: number[] = [];

    const result = await createMetaAdapter({
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }).fetchInsights(creds, 'act_123', range);

    expect(sleeps).toEqual([RATE_LIMIT_PAUSE_MS]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.truncatedByRateLimit).toBe(false);
  });

  it('stops paging (without waiting) once Meta has already throttled the account, and reports it', async () => {
    const usage = JSON.stringify({
      act_123: [
        { call_count: 1, total_cputime: 1, total_time: 1, estimated_time_to_regain_access: 3 },
      ],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          { data: [row()], paging: { cursors: { after: 'CURSOR1' } } },
          { 'x-business-use-case-usage': usage },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createMetaAdapter().fetchInsights(creds, 'act_123', range);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.truncatedByRateLimit).toBe(true);
    expect(result.rows).toHaveLength(1);
  });

  it('retries a throttle error (code 17) with backoff, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(400, { error: { message: 'User request limit reached', code: 17 } }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: [row()] }));
    vi.stubGlobal('fetch', fetchMock);
    const sleeps: number[] = [];

    const result = await createMetaAdapter({
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }).fetchInsights(creds, 'act_123', range);

    expect(sleeps).toEqual([30_000]); // throttleBackoffMs(1)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.rows).toHaveLength(1);
  });

  it('does not retry a non-throttle error, and never logs the response body in the thrown message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(400, {
          error: { message: 'super secret token leak: EAAtest', code: 100 },
        }),
      ),
    );
    await expect(createMetaAdapter().fetchInsights(creds, 'act_123', range)).rejects.toThrow(
      /Meta Insights API returned 400/,
    );
    try {
      await createMetaAdapter().fetchInsights(creds, 'act_123', range);
    } catch (error) {
      expect(String(error)).not.toContain('EAAtest');
    }
  });

  it('gives up after 6 throttled attempts, backing off 30s, 60s, 120s, 240s, 480s between them', async () => {
    // A fresh Response per call: a Response's body can only be read once, and `mockResolvedValue`
    // would otherwise hand out the same (already-consumed) instance on every retry.
    const fetchMock = vi
      .fn()
      .mockImplementation(() => jsonResponse(400, { error: { message: 'throttled', code: 613 } }));
    vi.stubGlobal('fetch', fetchMock);
    const sleeps: number[] = [];

    const result = await createMetaAdapter({
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    })
      .fetchInsights(creds, 'act_123', range)
      .catch((e: unknown) => e);

    expect(result).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(sleeps).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
  });

  it('rejects an unexpected response shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { not: 'the documented shape' })),
    );
    await expect(createMetaAdapter().fetchInsights(creds, 'act_123', range)).rejects.toThrow(
      /unexpected response shape/,
    );
  });
});

describe('createMetaAdapter — healthCheck', () => {
  it('is healthy on a valid /me response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { id: '123' })));
    expect(await createMetaAdapter().healthCheck(creds)).toEqual({ healthy: true });
  });

  it('is unhealthy with the Graph API error message on a 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(401, { error: { message: 'Invalid OAuth token', code: 190 } }),
        ),
    );
    expect(await createMetaAdapter().healthCheck(creds)).toEqual({
      healthy: false,
      reason: 'Invalid OAuth token',
    });
  });

  it('is unhealthy, not throwing, on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    expect(await createMetaAdapter().healthCheck(creds)).toEqual({
      healthy: false,
      reason: 'ECONNRESET',
    });
  });
});
