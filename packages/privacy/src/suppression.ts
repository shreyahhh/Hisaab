import { storeBoundScope, suppressionSetKey, type SuppressionSetKind } from '@truepath/shared';

// Reading the suppression sets (HLD §8 "Suppression set") for callers that need one answer about one
// shopper: the order webhook and backfill (an erased identity's order is stored without hashes), and the
// identity-stitch worker (an erased shopper is never stitched). The sets are per-store sorted sets:
// member = HMAC, score = expiry (epoch seconds), and an entry counts only while its score is in the
// future. Postgres `suppressed_identities` is the source of truth; these read the hot copy.
//
// Deliberately typed against the one method it needs, not against ioredis, so `packages/privacy` stays
// free of a Redis dependency and both the API and Workers can pass their own client.

export interface SuppressionReader {
  zscore(key: string, member: string): Promise<string | null>;
}

async function anyActive(
  reader: SuppressionReader,
  storeId: string,
  kind: SuppressionSetKind,
  members: readonly string[],
  nowSeconds: number,
): Promise<boolean> {
  const key = suppressionSetKey(storeBoundScope(storeId), storeId, kind);
  for (const member of members) {
    const score = await reader.zscore(key, member);
    if (score !== null && Number(score) > nowSeconds) return true;
  }
  return false;
}

/**
 * Is any of these identity HMACs (phone / email, under whichever key versions the caller can compute) on
 * the store's erased-identity list? An erased shopper's identifiers must never be stored or stitched.
 */
export function isIdentityErased(
  reader: SuppressionReader,
  storeId: string,
  identityHashes: readonly string[],
  nowSeconds: number,
): Promise<boolean> {
  return anyActive(reader, storeId, 'erased:identity', identityHashes, nowSeconds);
}

export type VisitorSuppression = 'erased' | 'withdrawn' | null;

/**
 * Is this visitor erased, or (with `includeWithdrawn`, the default) withdrawn? `visitorHmacs` is the
 * visitor's HMAC under every read key version. Erased wins over withdrawn.
 */
export async function visitorSuppression(
  reader: SuppressionReader,
  storeId: string,
  visitorHmacs: readonly string[],
  nowSeconds: number,
  options: { readonly includeWithdrawn?: boolean } = {},
): Promise<VisitorSuppression> {
  if (await anyActive(reader, storeId, 'erased:visitor', visitorHmacs, nowSeconds)) return 'erased';
  if (
    options.includeWithdrawn !== false &&
    (await anyActive(reader, storeId, 'withdrawn:visitor', visitorHmacs, nowSeconds))
  ) {
    return 'withdrawn';
  }
  return null;
}
