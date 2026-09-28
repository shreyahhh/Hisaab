import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  COLLECT_SIGNATURE_TOLERANCE_SECONDS,
  collectSigningInput,
  type CollectorStoreConfig,
} from '@truepath/shared';

// Request signature (collector.md §4 step 3): `sig = HMAC-SHA256(secret[kid], "<ts>.<rawBody>")`, hex,
// with `ts` within ±300 s of now. Two `kid`s are accepted during a key rotation (the config lists up
// to two). Constant-time compare throughout.
//
// What this is worth (collector.md §6): the secret ships to every shopper's browser, so it stops casual
// forgery and replay beyond five minutes — it does not authenticate the sender.

export type SignatureFailure = 'invalid_signature' | 'stale_signature';

export function verifySignature(
  config: Pick<CollectorStoreConfig, 'signingKeys'>,
  input: { ts?: string | undefined; kid?: string | undefined; sig?: string | undefined },
  rawBody: string,
  nowMs: number,
): { ok: true } | { ok: false; reason: SignatureFailure } {
  const { ts, kid, sig } = input;
  if (!ts || !kid || !sig || !/^\d{1,12}$/.test(ts)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  if (Math.abs(nowMs / 1000 - Number(ts)) > COLLECT_SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale_signature' };
  }
  const key = config.signingKeys.find((k) => k.kid === kid);
  if (!key || !/^[0-9a-f]{64}$/i.test(sig)) return { ok: false, reason: 'invalid_signature' };

  const expected = createHmac('sha256', key.secret)
    .update(collectSigningInput(ts, rawBody))
    .digest();
  const given = Buffer.from(sig, 'hex');
  // Both are 32 bytes here (the regex above guarantees 64 hex chars), so timingSafeEqual cannot throw.
  return timingSafeEqual(expected, given)
    ? { ok: true }
    : { ok: false, reason: 'invalid_signature' };
}
