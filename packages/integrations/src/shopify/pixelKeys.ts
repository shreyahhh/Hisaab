import { randomBytes, randomInt } from 'node:crypto';
import type { PixelSigningKey } from './types.js';

// Generators for the pixel's public store key and its HMAC signing secret
// (shopify-integration.md §4.1 step 5). Both come from Node's CSPRNG.

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * `pk_` + 24 base62 characters. Public by design (it is in the pixel's settings), so it identifies a
 * store to the Collector but authorises nothing on its own. `randomInt` is uniform over its range, so
 * there is no modulo bias in the alphabet mapping.
 */
export function generateStoreKey(): string {
  let key = 'pk_';
  for (let i = 0; i < 24; i += 1) key += BASE62[randomInt(BASE62.length)];
  return key;
}

/**
 * A signing key: 32 random bytes, base64url (43 chars, above the Collector's 32-char minimum).
 * The secret ships to every shopper's browser inside the pixel settings, so it stops casual forgery
 * and replay — it is not a credential (collector.md §6 "What the signature is worth").
 */
export function generateSigningKey(kid: string): PixelSigningKey {
  return { kid, secret: randomBytes(32).toString('base64url') };
}

/** The next unused `kid` for a rotation: `s1`, `s2`, … */
export function nextSigningKid(existing: readonly PixelSigningKey[]): string {
  const numbers = existing
    .map((k) => /^s(\d+)$/.exec(k.kid)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return `s${(numbers.length > 0 ? Math.max(...numbers) : 0) + 1}`;
}
