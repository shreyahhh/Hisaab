import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  SESSION_GAP_MS,
  SESSION_STATE_TTL_SECONDS,
  type SessionAssignment,
  type SessionEventInput,
} from '@truepath/shared';

// `session_assign_v1` (event-pipeline.md §4.2): one atomic Redis call per visitor per batch. It reads
// `session:<store_id>:<visitor_id>`, walks that visitor's events in `occurred_at` order applying the
// session rules, and writes the state back — so two consumers touching the same visitor can't
// interleave a read-modify-write. The rules are the ones in `assignSession` (packages/shared); a
// differential test runs both over the same sequences, so change them together.
//
// The script reads and writes exactly the one key it is given, which the caller builds with
// `sessionKey(scope, storeId, visitorId)`. It generates nothing: session ids arrive as arguments
// (UUID v7 built by the caller), which keeps the script deterministic.

export const SESSION_ASSIGN_SCRIPT = `
local key = KEYS[1]
local a = cjson.decode(ARGV[1])

local st = redis.call('HMGET', key, 'session_id', 'last_at', 'campaign_fp', 'start_ref')
local has = st[1] ~= false and tonumber(st[2]) ~= nil
local sid, last, fp, sref = '', 0, '', ''
if has then
  sid = st[1]
  last = tonumber(st[2])
  fp = st[3] or ''
  sref = st[4] or ''
end

local results = {}
local dirty = false
for i, e in ipairs(a.events) do
  if e.consent then
    results[i] = { sid = has and sid or '', started = false }
  else
    local start = false
    if not has then
      start = true
    elseif e.at >= last then
      if e.at - last > a.gapMs
        or (e.fp ~= '' and e.fp ~= fp)
        or (e.ref ~= '' and e.ref ~= sref) then
        start = true
      end
    end
    if start then
      sid = e.newId
      last = e.at
      fp = e.fp
      sref = e.ref
      has = true
    elseif e.at > last then
      last = e.at
    end
    dirty = true
    results[i] = { sid = sid, started = start }
  end
end

if dirty then
  redis.call('HSET', key, 'session_id', sid, 'last_at', string.format('%.0f', last),
    'campaign_fp', fp, 'start_ref', sref)
  redis.call('EXPIRE', key, a.ttlSeconds)
end

return cjson.encode({ results = results })
`;

export const SESSION_ASSIGN_SCRIPT_SHA = createHash('sha1')
  .update(SESSION_ASSIGN_SCRIPT)
  .digest('hex');

/**
 * Assigns sessions to one visitor's events. `events` may arrive in any order: they are applied in
 * `occurred_at` order (ties in the order given), and the returned assignments line up with the input
 * order. An empty list makes no Redis call.
 */
export async function assignSessions(
  redis: Pick<Redis, 'evalsha' | 'eval'>,
  sessionKey: string,
  events: readonly SessionEventInput[],
): Promise<SessionAssignment[]> {
  if (events.length === 0) return [];

  const order = events
    .map((_, index) => index)
    .sort((x, y) => events[x]!.occurred_at_ms - events[y]!.occurred_at_ms || x - y);
  const argv = JSON.stringify({
    gapMs: SESSION_GAP_MS,
    ttlSeconds: SESSION_STATE_TTL_SECONDS,
    events: order.map((i) => {
      const e = events[i]!;
      return {
        at: e.occurred_at_ms,
        fp: e.campaign_fp,
        ref: e.external_referrer_host,
        consent: e.is_consent,
        newId: e.new_session_id,
      };
    }),
  });

  let raw: unknown;
  try {
    raw = await redis.evalsha(SESSION_ASSIGN_SCRIPT_SHA, 1, sessionKey, argv);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('NOSCRIPT')) throw error;
    // EVAL also caches the script, so later calls go back to EVALSHA.
    raw = await redis.eval(SESSION_ASSIGN_SCRIPT, 1, sessionKey, argv);
  }

  const parsed = JSON.parse(String(raw)) as { results: { sid: string; started: boolean }[] };
  if (!Array.isArray(parsed.results) || parsed.results.length !== events.length) {
    throw new Error('session_assign_v1 returned an unexpected result');
  }
  const out: SessionAssignment[] = new Array<SessionAssignment>(events.length);
  order.forEach((inputIndex, position) => {
    const r = parsed.results[position]!;
    out[inputIndex] = { session_id: r.sid, started: r.started };
  });
  return out;
}
