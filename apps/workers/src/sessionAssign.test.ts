import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SESSION_STATE_TTL_SECONDS,
  assignSession,
  type SessionAssignment,
  type SessionEventInput,
  type SessionState,
} from '@truepath/shared';
import {
  SESSION_ASSIGN_SCRIPT,
  SESSION_ASSIGN_SCRIPT_SHA,
  assignSessions,
} from './sessionAssign.js';

// Integration test against the local durable Redis (like the Collector's). Keys are namespaced per run
// with a random prefix and deleted afterwards; nothing here touches a real `session:*` key.

const redis = new Redis('redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  connectTimeout: 1000,
});
const runId = randomUUID();
const used: string[] = [];
const freshKey = (): string => {
  const key = `test:${runId}:session:${randomUUID()}`;
  used.push(key);
  return key;
};

const T0 = Date.parse('2026-09-28T10:00:00.000Z');
const MIN = 60_000;
let counter = 0;
function ev(at: number, overrides: Partial<SessionEventInput> = {}): SessionEventInput {
  counter += 1;
  return {
    occurred_at_ms: at,
    campaign_fp: '',
    external_referrer_host: '',
    is_consent: false,
    new_session_id: `id-${counter}`,
    ...overrides,
  };
}

/** The reference implementation, applied to the events in the order the script applies them. */
function reference(events: SessionEventInput[], initial: SessionState | null): SessionAssignment[] {
  const order = events
    .map((_, i) => i)
    .sort((x, y) => events[x]!.occurred_at_ms - events[y]!.occurred_at_ms || x - y);
  const out: SessionAssignment[] = new Array<SessionAssignment>(events.length);
  let state = initial;
  for (const i of order) {
    const r = assignSession(state, events[i]!);
    state = r.state;
    out[i] = r.assignment;
  }
  return out;
}

async function readState(key: string): Promise<SessionState | null> {
  const h = await redis.hgetall(key);
  if (h.session_id === undefined) return null;
  return {
    session_id: h.session_id,
    last_at: Number(h.last_at),
    campaign_fp: h.campaign_fp ?? '',
    start_ref: h.start_ref ?? '',
  };
}

beforeAll(async () => {
  await redis.ping();
});

afterAll(async () => {
  if (used.length > 0) await redis.del(...used);
  redis.disconnect();
});

describe('session_assign_v1', () => {
  it('starts a session, stores the state hash and sets the 2 h expiry', async () => {
    const key = freshKey();
    const e = ev(T0, { campaign_fp: 'fb||1|||x', external_referrer_host: 'google.com' });
    expect(await assignSessions(redis, key, [e])).toEqual([
      { session_id: e.new_session_id, started: true },
    ]);
    expect(await redis.hgetall(key)).toEqual({
      session_id: e.new_session_id,
      last_at: String(T0),
      campaign_fp: 'fb||1|||x',
      start_ref: 'google.com',
    });
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(SESSION_STATE_TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(SESSION_STATE_TTL_SECONDS);
  });

  it('returns nothing and touches nothing for an empty list', async () => {
    const key = freshKey();
    expect(await assignSessions(redis, key, [])).toEqual([]);
    expect(await redis.exists(key)).toBe(0);
  });

  it('sorts a batch by occurred_at, so a replayed landing becomes the session start (late consent)', async () => {
    const key = freshKey();
    const consent = ev(T0 + 5 * MIN, { is_consent: true });
    const later = ev(T0 + 2 * MIN);
    const landing = ev(T0, { campaign_fp: 'fb||1|||x' });
    // arrival order: consent, a later page, then the replayed landing
    const out = await assignSessions(redis, key, [consent, later, landing]);
    expect(out[2]).toEqual({ session_id: landing.new_session_id, started: true });
    expect(out[1]).toEqual({ session_id: landing.new_session_id, started: false });
    expect(out[0]).toEqual({ session_id: landing.new_session_id, started: false });
  });

  it('a consent-only batch writes no state; consent has no session yet', async () => {
    const key = freshKey();
    expect(await assignSessions(redis, key, [ev(T0, { is_consent: true })])).toEqual([
      { session_id: '', started: false },
    ]);
    expect(await redis.exists(key)).toBe(0);
  });

  it('carries state across calls (the 30-minute rule spans batches)', async () => {
    const key = freshKey();
    const [first] = await assignSessions(redis, key, [ev(T0)]);
    const [joined] = await assignSessions(redis, key, [ev(T0 + 29 * MIN)]);
    const [fresh] = await assignSessions(redis, key, [ev(T0 + 29 * MIN + 31 * MIN)]);
    expect(joined).toEqual({ session_id: first!.session_id, started: false });
    expect(fresh!.started).toBe(true);
    expect(fresh!.session_id).not.toBe(first!.session_id);
  });

  it('exactly 30 minutes idle still joins; one millisecond more starts a new session', async () => {
    const key = freshKey();
    const [first] = await assignSessions(redis, key, [ev(T0)]);
    const [at30] = await assignSessions(redis, key, [ev(T0 + 30 * MIN)]);
    const [over] = await assignSessions(redis, key, [ev(T0 + 60 * MIN + 1)]);
    expect(at30).toEqual({ session_id: first!.session_id, started: false });
    expect(over!.started).toBe(true);
  });

  it('an older event in a later call joins the current session and leaves last_at alone', async () => {
    const key = freshKey();
    const [first] = await assignSessions(redis, key, [ev(T0 + 20 * MIN, { campaign_fp: 'A' })]);
    const [old] = await assignSessions(redis, key, [
      ev(T0, { campaign_fp: 'B', external_referrer_host: 'google.com' }),
    ]);
    expect(old).toEqual({ session_id: first!.session_id, started: false });
    expect((await readState(key))!.last_at).toBe(T0 + 20 * MIN);
  });

  it('treats a corrupted state hash as no state', async () => {
    const key = freshKey();
    await redis.hset(key, { session_id: 'old', last_at: 'garbage' });
    const e = ev(T0);
    expect(await assignSessions(redis, key, [e])).toEqual([
      { session_id: e.new_session_id, started: true },
    ]);
  });

  it('falls back to EVAL when the server has not cached the script (NOSCRIPT)', async () => {
    // A stand-in client, so the shared local Redis's script cache is left alone.
    const calls: string[] = [];
    const key = freshKey();
    const noScript = {
      evalsha: () => {
        calls.push('evalsha');
        return Promise.reject(new Error('NOSCRIPT No matching script. Please use EVAL.'));
      },
      eval: (...args: unknown[]) => {
        calls.push('eval');
        expect(args[0]).toBe(SESSION_ASSIGN_SCRIPT);
        return redis.eval(SESSION_ASSIGN_SCRIPT, 1, key, args[3] as string);
      },
    } as unknown as Pick<Redis, 'evalsha' | 'eval'>;
    const e = ev(T0);
    expect(await assignSessions(noScript, key, [e])).toEqual([
      { session_id: e.new_session_id, started: true },
    ]);
    expect(calls).toEqual(['evalsha', 'eval']);
  });

  it('does not swallow other Redis errors', async () => {
    const broken = {
      evalsha: () =>
        Promise.reject(new Error("READONLY You can't write against a read only replica.")),
      eval: () => Promise.reject(new Error('should not be called')),
    } as unknown as Pick<Redis, 'evalsha' | 'eval'>;
    await expect(assignSessions(broken, freshKey(), [ev(T0)])).rejects.toThrow('READONLY');
  });

  it('the cached script is the one whose SHA we call', async () => {
    const key = freshKey();
    await redis.eval(
      SESSION_ASSIGN_SCRIPT,
      1,
      key,
      JSON.stringify({ gapMs: 1, ttlSeconds: 10, events: [] }),
    );
    expect(await redis.script('EXISTS', SESSION_ASSIGN_SCRIPT_SHA)).toEqual([1]);
  });

  // The Lua script and `assignSession` must agree. Seeded generator (fast-check isn't an approved
  // dependency yet), covering every rule and out-of-order input across several calls per visitor.
  it('agrees with the reference implementation on random sequences', async () => {
    let seed = 20260928;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

    for (let visitor = 0; visitor < 150; visitor += 1) {
      const key = freshKey();
      let state: SessionState | null = null;
      for (let call = 0; call < 4; call += 1) {
        const size = 1 + Math.floor(rand() * 5);
        const events = Array.from({ length: size }, () =>
          ev(T0 + Math.floor((rand() * 3 - 0.5) * 60) * MIN + Math.floor(rand() * 3) * 1000, {
            campaign_fp: pick(['', '', '', 'A', 'B']),
            external_referrer_host: pick(['', '', 'google.com', 'blog.example.org']),
            is_consent: rand() < 0.15,
          }),
        );
        const expected = reference(events, state);
        const actual = await assignSessions(redis, key, events);
        expect(actual).toEqual(expected);

        // advance the reference state exactly as the script did
        const order = events
          .map((_, i) => i)
          .sort((x, y) => events[x]!.occurred_at_ms - events[y]!.occurred_at_ms || x - y);
        for (const i of order) state = assignSession(state, events[i]!).state;
        expect(await readState(key)).toEqual(state);
      }
    }
    // ~1,200 sequential Redis round trips: about a second alone, over the 5 s default when the whole
    // suite shares one Redis and Postgres.
  }, 60_000);
});
