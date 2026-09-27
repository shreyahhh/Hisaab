import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';

// Shopify OAuth `state`: HMAC-signed token + single-use Redis nonce (ADR-0025). Not a JWT — see the
// ADR for why. The nonce is the actual single-use control; the signature only proves the token
// wasn't tampered with and hasn't yet passed its own `exp`.

const STATE_TTL_SECONDS = 600; // 10 minutes (shopify-integration.md §2.1)

function nonceKey(nonce: string): string {
  return `oauth:shopify:state:${nonce}`;
}

export interface ShopifyOAuthStateClaims {
  readonly userId: string;
  readonly organizationId: string;
  readonly shop: string;
}

export interface ShopifyOAuthStateDeps {
  readonly redis: Redis;
  /** SHOPIFY_OAUTH_STATE_SECRET — distinct from every other secret in the app (ADR-0025). */
  readonly secret: string;
}

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

function sign(secret: string, payloadB64: string): string {
  return base64url(createHmac('sha256', secret).update(payloadB64).digest());
}

/**
 * Issues a state token for `GET .../connect` and writes its nonce to durable Redis with a 10-minute
 * TTL. The Redis value is the same claims the signed token carries — redundant with the signature by
 * design (defense in depth: the callback re-checks both agree).
 */
export async function issueShopifyOAuthState(
  deps: ShopifyOAuthStateDeps,
  claims: ShopifyOAuthStateClaims,
): Promise<string> {
  const nonce = randomUUID();
  const exp = Date.now() + STATE_TTL_SECONDS * 1000;
  const payload = { ...claims, nonce, exp };
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = sign(deps.secret, payloadB64);

  await deps.redis.set(nonceKey(nonce), JSON.stringify(claims), 'EX', STATE_TTL_SECONDS);
  return `${payloadB64}.${signature}`;
}

export type ConsumeShopifyOAuthStateResult =
  | { readonly ok: true; readonly claims: ShopifyOAuthStateClaims }
  | {
      readonly ok: false;
      readonly reason: 'malformed' | 'bad_signature' | 'expired' | 'nonce_invalid';
    };

// Atomic GET-then-DEL, so a nonce can never be read and reused by two concurrent callbacks (a plain
// GET followed by a separate DEL would race). Works on any Redis version, unlike the GETDEL command
// (Redis >= 6.2 only).
const GET_AND_DELETE = `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v
`;

/**
 * Verifies the signature and `exp`, then atomically consumes the nonce (ADR-0025): a token can be
 * consumed exactly once, and a missing/expired nonce fails exactly like a bad signature — a caller
 * can't tell "already used" from "forged" from the result shape alone.
 */
export async function consumeShopifyOAuthState(
  deps: ShopifyOAuthStateDeps,
  token: string,
): Promise<ConsumeShopifyOAuthStateResult> {
  const dot = token.indexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };
  const payloadB64 = token.slice(0, dot);
  const signatureB64 = token.slice(dot + 1);

  const expectedSignature = sign(deps.secret, payloadB64);
  if (!timingSafeCompare(signatureB64, expectedSignature)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let parsed: {
    userId: unknown;
    organizationId: unknown;
    shop: unknown;
    nonce: unknown;
    exp: unknown;
  };
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof parsed.userId !== 'string' ||
    typeof parsed.organizationId !== 'string' ||
    typeof parsed.shop !== 'string' ||
    typeof parsed.nonce !== 'string' ||
    typeof parsed.exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (Date.now() > parsed.exp) {
    return { ok: false, reason: 'expired' };
  }

  const raw = (await deps.redis.eval(GET_AND_DELETE, 1, nonceKey(parsed.nonce))) as string | null;
  if (raw === null) {
    return { ok: false, reason: 'nonce_invalid' };
  }

  let stored: { userId: unknown; organizationId: unknown; shop: unknown };
  try {
    stored = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'nonce_invalid' };
  }
  const claims: ShopifyOAuthStateClaims = {
    userId: parsed.userId,
    organizationId: parsed.organizationId,
    shop: parsed.shop,
  };
  // Defense in depth (ADR-0025): the signed payload and the Redis-stored claims must agree.
  if (
    stored.userId !== claims.userId ||
    stored.organizationId !== claims.organizationId ||
    stored.shop !== claims.shop
  ) {
    return { ok: false, reason: 'nonce_invalid' };
  }
  return { ok: true, claims };
}

function timingSafeCompare(a: string, b: string): boolean {
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, 'base64url');
    bufB = Buffer.from(b, 'base64url');
  } catch {
    return false;
  }
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}
