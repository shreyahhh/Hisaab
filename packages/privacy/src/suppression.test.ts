import { describe, expect, it } from 'vitest';
import { storeBoundScope, suppressionSetKey, type SuppressionSetKind } from '@truepath/shared';
import { isIdentityErased, visitorSuppression, type SuppressionReader } from './suppression.js';

const STORE = '0192f3a4-7b1c-7c2d-8e3f-4a5b6c7d8e9f';
const OTHER = '0192f3a4-7b1c-7c2d-8e3f-4a5b6c7d8ea0';
const NOW = 1_800_000_000;
const h = (n: number): string => `k1:${n.toString(16).padStart(64, '0')}`;

function reader(entries: Array<[SuppressionSetKind, string, number, string?]>): SuppressionReader {
  const sets = new Map<string, number>();
  for (const [kind, member, score, store = STORE] of entries) {
    sets.set(`${suppressionSetKey(storeBoundScope(store), store, kind)}|${member}`, score);
  }
  return {
    zscore: (key, member) => {
      const score = sets.get(`${key}|${member}`);
      return Promise.resolve(score === undefined ? null : String(score));
    },
  };
}

describe('isIdentityErased', () => {
  it('is true when any listed hash is on the erased-identity list with a future expiry', async () => {
    const r = reader([['erased:identity', h(2), NOW + 100]]);
    expect(await isIdentityErased(r, STORE, [h(1), h(2)], NOW)).toBe(true);
  });

  it('ignores an expired entry, an absent hash and an empty list', async () => {
    const r = reader([['erased:identity', h(2), NOW - 1]]);
    expect(await isIdentityErased(r, STORE, [h(2)], NOW)).toBe(false);
    expect(await isIdentityErased(r, STORE, [h(3)], NOW)).toBe(false);
    expect(await isIdentityErased(r, STORE, [], NOW)).toBe(false);
  });

  it("does not see another store's erased identity (per-store sets)", async () => {
    const r = reader([['erased:identity', h(2), NOW + 100, OTHER]]);
    expect(await isIdentityErased(r, STORE, [h(2)], NOW)).toBe(false);
  });

  it('is not fooled by the same hash on a different kind of set', async () => {
    const r = reader([['erased:visitor', h(2), NOW + 100]]);
    expect(await isIdentityErased(r, STORE, [h(2)], NOW)).toBe(false);
  });
});

describe('visitorSuppression', () => {
  it('reports erased, then withdrawn, then nothing', async () => {
    const r = reader([
      ['erased:visitor', h(1), NOW + 100],
      ['withdrawn:visitor', h(2), NOW + 100],
      ['withdrawn:visitor', h(1), NOW + 100],
    ]);
    expect(await visitorSuppression(r, STORE, [h(1)], NOW)).toBe('erased');
    expect(await visitorSuppression(r, STORE, [h(2)], NOW)).toBe('withdrawn');
    expect(await visitorSuppression(r, STORE, [h(3)], NOW)).toBeNull();
  });

  it('can leave withdrawn out (consent events may pass a withdrawn visitor)', async () => {
    const r = reader([['withdrawn:visitor', h(2), NOW + 100]]);
    expect(await visitorSuppression(r, STORE, [h(2)], NOW, { includeWithdrawn: false })).toBeNull();
  });

  it('matches under any key version supplied, and ignores expired entries', async () => {
    const r = reader([
      ['erased:visitor', h(9), NOW + 100],
      ['withdrawn:visitor', h(8), NOW - 5],
    ]);
    expect(await visitorSuppression(r, STORE, [h(1), h(9)], NOW)).toBe('erased');
    expect(await visitorSuppression(r, STORE, [h(8)], NOW)).toBeNull();
  });
});
