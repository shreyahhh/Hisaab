import { describe, expect, it } from 'vitest';
import {
  SESSION_GAP_MS,
  assignSession,
  type SessionEventInput,
  type SessionState,
} from './session.js';
import { UUID_V7_PATTERN, uuidV7 } from './uuid.js';

const T0 = Date.parse('2026-09-28T10:00:00.000Z');
const MIN = 60_000;

let n = 0;
function ev(overrides: Partial<SessionEventInput> & { at: number }): SessionEventInput {
  n += 1;
  const { at, ...rest } = overrides;
  return {
    occurred_at_ms: at,
    campaign_fp: '',
    external_referrer_host: '',
    is_consent: false,
    new_session_id: `s${n}`,
    ...rest,
  };
}

/** Feeds events in order, returning the assignments and the final state. */
function run(events: SessionEventInput[], initial: SessionState | null = null) {
  let state = initial;
  const out = events.map((e) => {
    const r = assignSession(state, e);
    state = r.state;
    return r.assignment;
  });
  return { out, state };
}

describe('assignSession', () => {
  it('rule 1: the first event starts a session using the supplied id', () => {
    const e = ev({ at: T0, campaign_fp: 'fb||1|||x', external_referrer_host: 'google.com' });
    const { out, state } = run([e]);
    expect(out).toEqual([{ session_id: e.new_session_id, started: true }]);
    expect(state).toEqual({
      session_id: e.new_session_id,
      last_at: T0,
      campaign_fp: 'fb||1|||x',
      start_ref: 'google.com',
    });
  });

  it('rule 2: 29 minutes idle joins, 31 minutes starts a new session', () => {
    const a = run([ev({ at: T0 }), ev({ at: T0 + 29 * MIN })]);
    expect(a.out[1]!.started).toBe(false);
    expect(a.out[1]!.session_id).toBe(a.out[0]!.session_id);

    const b = run([ev({ at: T0 }), ev({ at: T0 + 31 * MIN })]);
    expect(b.out[1]!.started).toBe(true);
    expect(b.out[1]!.session_id).not.toBe(b.out[0]!.session_id);
  });

  it('rule 2: exactly 30 minutes still joins (the gap must be exceeded)', () => {
    expect(SESSION_GAP_MS).toBe(30 * MIN);
    expect(run([ev({ at: T0 }), ev({ at: T0 + 30 * MIN })]).out[1]!.started).toBe(false);
  });

  it('the gap is measured from the latest event, not from the session start', () => {
    const { out } = run([
      ev({ at: T0 }),
      ev({ at: T0 + 25 * MIN }),
      ev({ at: T0 + 50 * MIN }),
      ev({ at: T0 + 75 * MIN }),
    ]);
    expect(new Set(out.map((o) => o.session_id)).size).toBe(1);
  });

  it('rule 3: a changed campaign fingerprint within 5 minutes starts a new session', () => {
    const { out } = run([
      ev({ at: T0, campaign_fp: 'A' }),
      ev({ at: T0 + 5 * MIN, campaign_fp: 'B' }),
    ]);
    expect(out[1]!.started).toBe(true);
  });

  it('rule 3: the same fingerprint, or none, joins — and an event with none does not reset the fingerprint', () => {
    const { out, state } = run([
      ev({ at: T0, campaign_fp: 'A' }),
      ev({ at: T0 + MIN, campaign_fp: 'A' }),
      ev({ at: T0 + 2 * MIN, campaign_fp: '' }),
    ]);
    expect(out.map((o) => o.started)).toEqual([true, false, false]);
    expect(state!.campaign_fp).toBe('A');
  });

  it('rule 3: a campaign appearing on a session that started without one starts a new session', () => {
    expect(run([ev({ at: T0 }), ev({ at: T0 + MIN, campaign_fp: 'A' })]).out[1]!.started).toBe(
      true,
    );
  });

  it('rule 4: a new external referrer starts a session; the same one does not', () => {
    const { out } = run([
      ev({ at: T0, external_referrer_host: 'google.com' }),
      ev({ at: T0 + MIN, external_referrer_host: 'google.com' }),
      ev({ at: T0 + 2 * MIN, external_referrer_host: 'blog.example.org' }),
      ev({ at: T0 + 3 * MIN, external_referrer_host: '' }),
    ]);
    expect(out.map((o) => o.started)).toEqual([true, false, true, false]);
  });

  it('rule 4: an external referrer on a session that started direct starts a new session', () => {
    expect(
      run([ev({ at: T0 }), ev({ at: T0 + MIN, external_referrer_host: 'google.com' })]).out[1]!
        .started,
    ).toBe(true);
  });

  it('an out-of-order event joins the current session and never starts one', () => {
    const { out, state } = run([
      ev({ at: T0 + 10 * MIN, campaign_fp: 'A' }),
      // older than last_at, with a different campaign and a referrer: still joins
      ev({ at: T0, campaign_fp: 'B', external_referrer_host: 'google.com' }),
      // far older than 30 min before last_at: still joins
      ev({ at: T0 - 90 * MIN }),
    ]);
    expect(out.map((o) => o.started)).toEqual([true, false, false]);
    expect(new Set(out.map((o) => o.session_id)).size).toBe(1);
    expect(state!.last_at).toBe(T0 + 10 * MIN);
    expect(state!.campaign_fp).toBe('A');
  });

  it('consent events never start a session and never move the state', () => {
    const first = run([ev({ at: T0, is_consent: true })]);
    expect(first.out).toEqual([{ session_id: '', started: false }]);
    expect(first.state).toBeNull();

    const { out, state } = run([
      ev({ at: T0 }),
      ev({
        at: T0 + 2 * 60 * MIN,
        is_consent: true,
        campaign_fp: 'Z',
        external_referrer_host: 'x.com',
      }),
    ]);
    expect(out[1]).toEqual({ session_id: out[0]!.session_id, started: false });
    expect(state!.last_at).toBe(T0);
  });

  it('late consent: a replayed landing (sorted first) supplies the session start, consent does not', () => {
    // consent_granted arrives before the replayed page_viewed that carries the campaign.
    const { out } = run(
      [
        ev({ at: T0 + 5 * MIN, is_consent: true }),
        ev({ at: T0, campaign_fp: 'fb||1|||x' }), // caller sorts by occurred_at first; here fed as sorted below
      ].sort((a, b) => a.occurred_at_ms - b.occurred_at_ms),
    );
    expect(out[0]).toMatchObject({ started: true });
    expect(out[1]).toMatchObject({ session_id: out[0]!.session_id, started: false });
  });
});

describe('uuidV7', () => {
  it('produces RFC 9562 version 7 / variant 10 ids for any random input', () => {
    for (const fill of [0x00, 0x7f, 0xff]) {
      expect(uuidV7(T0, new Uint8Array(16).fill(fill))).toMatch(UUID_V7_PATTERN);
    }
  });
  it('encodes the millisecond timestamp in the first 48 bits, so ids sort by time', () => {
    const rand = new Uint8Array(16).fill(1);
    expect(uuidV7(T0, rand).replace('-', '').slice(0, 12)).toBe(T0.toString(16).padStart(12, '0'));
    expect(uuidV7(T0 + 1, rand) > uuidV7(T0, rand)).toBe(true);
  });
});
