import { describe, expect, it } from 'vitest';
import {
  decideRateLimit,
  isThrottleError,
  parseBusinessUseCaseUsage,
  parseGraphApiError,
  RATE_LIMIT_PAUSE_MS,
  throttleBackoffMs,
  THROTTLE_MAX_ATTEMPTS,
} from './rateLimit.js';

describe('parseBusinessUseCaseUsage', () => {
  it('parses the documented shape: an object of accountId → array of usage entries', () => {
    const header = JSON.stringify({
      act_123: [
        { call_count: 10, total_cputime: 5, total_time: 8, estimated_time_to_regain_access: 0 },
      ],
    });
    expect(parseBusinessUseCaseUsage(header)).toEqual([
      {
        accountId: 'act_123',
        callCount: 10,
        totalCputime: 5,
        totalTime: 8,
        estimatedTimeToRegainAccess: 0,
      },
    ]);
  });

  it('flattens multiple accounts and multiple entries per account', () => {
    const header = JSON.stringify({
      act_1: [
        { call_count: 1, total_cputime: 1, total_time: 1, estimated_time_to_regain_access: 0 },
      ],
      act_2: [
        { call_count: 2, total_cputime: 2, total_time: 2, estimated_time_to_regain_access: 0 },
        { call_count: 3, total_cputime: 3, total_time: 3, estimated_time_to_regain_access: 0 },
      ],
    });
    expect(parseBusinessUseCaseUsage(header).map((u) => u.accountId)).toEqual([
      'act_1',
      'act_2',
      'act_2',
    ]);
  });

  it.each([null, undefined, '', 'not json', '[]', '"a string"', '42', '{"a": "not an array"}'])(
    'returns [] for %j rather than throwing',
    (input) => {
      expect(parseBusinessUseCaseUsage(input)).toEqual([]);
    },
  );

  it('tolerates missing/non-numeric fields by defaulting to 0', () => {
    const header = JSON.stringify({ act_1: [{ call_count: 'nope' }] });
    expect(parseBusinessUseCaseUsage(header)).toEqual([
      {
        accountId: 'act_1',
        callCount: 0,
        totalCputime: 0,
        totalTime: 0,
        estimatedTimeToRegainAccess: 0,
      },
    ]);
  });
});

describe('decideRateLimit', () => {
  const usage = (over: Partial<Parameters<typeof decideRateLimit>[0][number]> = {}) => [
    {
      accountId: 'act_1',
      callCount: 1,
      totalCputime: 1,
      totalTime: 1,
      estimatedTimeToRegainAccess: 0,
      ...over,
    },
  ];

  it('proceeds when every metric is comfortably below threshold', () => {
    expect(decideRateLimit(usage())).toEqual({ action: 'proceed' });
    expect(decideRateLimit([])).toEqual({ action: 'proceed' });
  });

  it.each(['callCount', 'totalCputime', 'totalTime'] as const)(
    'pauses 60s when %s reaches 75',
    (field) => {
      expect(decideRateLimit(usage({ [field]: 75 }))).toEqual({
        action: 'pause',
        delayMs: RATE_LIMIT_PAUSE_MS,
      });
    },
  );

  it('does not pause at 74', () => {
    expect(decideRateLimit(usage({ callCount: 74 }))).toEqual({ action: 'proceed' });
  });

  it('backs off by estimated_time_to_regain_access minutes when it is set, even under the pause threshold', () => {
    expect(decideRateLimit(usage({ callCount: 10, estimatedTimeToRegainAccess: 5 }))).toEqual({
      action: 'backoff',
      delayMs: 5 * 60_000,
    });
  });

  it('backoff wins over pause when both apply', () => {
    expect(decideRateLimit(usage({ callCount: 90, estimatedTimeToRegainAccess: 2 }))).toEqual({
      action: 'backoff',
      delayMs: 2 * 60_000,
    });
  });

  it('takes the worst (longest) backoff across accounts', () => {
    expect(
      decideRateLimit([
        ...usage({ estimatedTimeToRegainAccess: 3 }),
        {
          accountId: 'act_2',
          callCount: 1,
          totalCputime: 1,
          totalTime: 1,
          estimatedTimeToRegainAccess: 9,
        },
      ]),
    ).toEqual({ action: 'backoff', delayMs: 9 * 60_000 });
  });
});

describe('parseGraphApiError / isThrottleError', () => {
  it('parses the documented error envelope', () => {
    const body = {
      error: {
        message: 'Reduce the amount of data',
        type: 'OAuthException',
        code: 17,
        fbtrace_id: 'abc123',
      },
    };
    expect(parseGraphApiError(body)).toEqual({
      code: 17,
      message: 'Reduce the amount of data',
      fbtraceId: 'abc123',
    });
  });

  it('carries error_subcode when present', () => {
    const body = { error: { message: 'x', code: 80004, error_subcode: 80004 } };
    expect(parseGraphApiError(body)?.errorSubcode).toBe(80004);
  });

  it.each([
    undefined,
    null,
    {},
    { error: 'not an object' },
    { error: {} },
    { error: { code: 'not a number' } },
    'a string',
    42,
  ])('returns null for %j', (body) => {
    expect(parseGraphApiError(body)).toBeNull();
  });

  it.each([17, 613])('treats API-level code %d as throttling', (code) => {
    expect(isThrottleError({ code, message: 'x' })).toBe(true);
  });

  it.each([80000, 80004])('treats business-use-case subcode %d as throttling', (subcode) => {
    expect(isThrottleError({ code: 1, errorSubcode: subcode, message: 'x' })).toBe(true);
  });

  it('does not treat an unrelated error as throttling', () => {
    expect(isThrottleError({ code: 100, message: 'Invalid parameter' })).toBe(false);
    expect(isThrottleError({ code: 100, errorSubcode: 1, message: 'x' })).toBe(false);
  });
});

describe('throttleBackoffMs', () => {
  it('doubles from 30s, capped at 16min, over 6 attempts', () => {
    expect([1, 2, 3, 4, 5, 6].map(throttleBackoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 960_000,
    ]);
    expect(THROTTLE_MAX_ATTEMPTS).toBe(6);
  });

  it('never exceeds the cap even past 6 attempts', () => {
    expect(throttleBackoffMs(10)).toBe(16 * 60_000);
  });
});
