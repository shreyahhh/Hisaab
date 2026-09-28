import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

// `collector_ingest_v1` (collector.md §4 step 10): suppression checks and the stream append in ONE
// Redis round trip, so there is no window between "not suppressed" and "appended" in which an erasure
// can land. The script only ever reads/writes the six keys it is given, all built by the caller from
// the verified store id.
//
// Behaviour, in order:
//   1. `suppress:ready` missing  → `not_ready` (the caller answers 503; nothing is appended).
//   2. visitor in the ERASED set → the whole batch is dropped (`suppressed_visitor`), consent events
//      included: an erased visitor may not even re-consent (privacy-dpdp: erased is permanent for the TTL).
//   3. any event's identity in the ERASED IDENTITY set (an erased shopper on a new device) → the
//      visitor is added to the erased set, a `suppression_hit` is appended, and the WHOLE batch —
//      earlier events included — is dropped (`suppressed_identity`), so nothing of this device is stored.
//   4. otherwise, per event: a WITHDRAWN visitor's non-consent events are dropped (`suppressed_visitor`);
//      consent events pass (so re-consent works); everything else is appended.
//   5. drop counters are added to `stats:collector:<store>:<day>` with a 100-day expiry.
//
// A suppression entry counts only while its score (expiry, epoch seconds) is in the future.

export const INGEST_SCRIPT = `
local ready = KEYS[1]
local stream = KEYS[2]
local erasedVisitor = KEYS[3]
local withdrawnVisitor = KEYS[4]
local erasedIdentity = KEYS[5]
local stats = KEYS[6]

if redis.call('EXISTS', ready) == 0 then
  return cjson.encode({status = 'not_ready'})
end

local a = cjson.decode(ARGV[1])
local now = a.nowSeconds
local drops = {}
local function drop(reason, n)
  drops[reason] = (drops[reason] or 0) + n
end
if a.preDrops then
  for reason, n in pairs(a.preDrops) do drop(reason, n) end
end

local function suppressed(setKey, members)
  for _, member in ipairs(members) do
    local score = redis.call('ZSCORE', setKey, member)
    if score and tonumber(score) > now then return true end
  end
  return false
end

local events = a.events
local accepted = 0

if #events > 0 and suppressed(erasedVisitor, a.visitorHmacs) then
  drop('suppressed_visitor', #events)
  events = {}
end

if #events > 0 then
  for _, e in ipairs(events) do
    if e.identityLookup and #e.identityLookup > 0 and suppressed(erasedIdentity, e.identityLookup) then
      redis.call('ZADD', erasedVisitor, now + a.suppressTtl, a.visitorHmacWrite)
      redis.call('XADD', stream, 'MAXLEN', '~', a.maxlen, '*',
        'store_id', a.storeId,
        'payload', cjson.encode({
          kind = 'suppression_hit',
          store_id = a.storeId,
          visitor_id = a.visitorId,
          identity_hash_hmac = e.identityHash,
          received_at = a.receivedAt
        }))
      drop('suppressed_identity', #events)
      events = {}
      break
    end
  end
end

if #events > 0 then
  local withdrawn = suppressed(withdrawnVisitor, a.visitorHmacs)
  for _, e in ipairs(events) do
    if withdrawn and not e.isConsent then
      drop('suppressed_visitor', 1)
    else
      redis.call('XADD', stream, 'MAXLEN', '~', a.maxlen, '*',
        'store_id', a.storeId, 'payload', e.payload)
      accepted = accepted + 1
    end
  end
end

local any = false
for reason, n in pairs(drops) do
  redis.call('HINCRBY', stats, reason, n)
  any = true
end
if any then redis.call('EXPIRE', stats, a.statsTtl) end

return cjson.encode({status = 'ok', accepted = accepted, drops = drops})
`;

export const INGEST_SCRIPT_SHA = createHash('sha1').update(INGEST_SCRIPT).digest('hex');

export interface IngestEvent {
  /** The `StreamEventEntry` JSON, ready to append. */
  readonly payload: string;
  /** `consent_granted` / `consent_withdrawn` — exempt from the withdrawn check. */
  readonly isConsent: boolean;
  /** Every read-version HMAC of the event's phone/email; empty when it has no usable identifier. */
  readonly identityLookup: readonly string[];
  /** The write-version identity hash, for the `suppression_hit` entry. */
  readonly identityHash?: string;
}

export interface IngestArgs {
  readonly nowSeconds: number;
  readonly maxlen: number;
  readonly statsTtl: number;
  readonly suppressTtl: number;
  readonly storeId: string;
  readonly visitorId: string;
  readonly receivedAt: string;
  /** HMAC(visitor_id) under every read version (lookup) and under the write version (insert). */
  readonly visitorHmacs: readonly string[];
  readonly visitorHmacWrite: string;
  /** Drops already decided before the script (consent, stale, foreign page), to be counted with its own. */
  readonly preDrops: Readonly<Record<string, number>>;
  readonly events: readonly IngestEvent[];
}

export interface IngestKeys {
  readonly ready: string;
  readonly stream: string;
  readonly erasedVisitor: string;
  readonly withdrawnVisitor: string;
  readonly erasedIdentity: string;
  readonly stats: string;
}

export type IngestResult =
  | { readonly status: 'not_ready' }
  | {
      readonly status: 'ok';
      readonly accepted: number;
      readonly drops: Readonly<Record<string, number>>;
    };

/** Runs the script by SHA, falling back to loading it once when the server doesn't have it cached. */
export async function runIngest(
  redis: Pick<Redis, 'evalsha' | 'eval'>,
  keys: IngestKeys,
  args: IngestArgs,
): Promise<IngestResult> {
  const keyList = [
    keys.ready,
    keys.stream,
    keys.erasedVisitor,
    keys.withdrawnVisitor,
    keys.erasedIdentity,
    keys.stats,
  ];
  const argv = JSON.stringify(args);
  let raw: unknown;
  try {
    raw = await redis.evalsha(INGEST_SCRIPT_SHA, keyList.length, ...keyList, argv);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('NOSCRIPT')) throw error;
    // EVAL also caches the script, so later calls go back to EVALSHA.
    raw = await redis.eval(INGEST_SCRIPT, keyList.length, ...keyList, argv);
  }
  const parsed = JSON.parse(String(raw)) as {
    status: string;
    accepted?: number;
    drops?: Record<string, number> | unknown[];
  };
  if (parsed.status === 'not_ready') return { status: 'not_ready' };
  return {
    status: 'ok',
    accepted: parsed.accepted ?? 0,
    // cjson encodes an empty Lua table as `{}`, but be tolerant of `[]`.
    drops: Array.isArray(parsed.drops) ? {} : (parsed.drops ?? {}),
  };
}
