import { describe, expect, it } from 'vitest';
import { generateSigningKey, generateStoreKey, nextSigningKid } from './pixelKeys.js';

describe('generateStoreKey', () => {
  it('is pk_ + 24 base62 characters', () => {
    for (let i = 0; i < 50; i += 1) expect(generateStoreKey()).toMatch(/^pk_[0-9A-Za-z]{24}$/);
  });

  it('does not repeat', () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateStoreKey()));
    expect(keys.size).toBe(500);
  });

  it('uses the whole alphabet, not a subset (no modulo-bias or truncation bug)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i += 1) for (const c of generateStoreKey().slice(3)) seen.add(c);
    expect(seen.size).toBe(62);
  });
});

describe('generateSigningKey', () => {
  it('is 32 random bytes, base64url, well above the Collector 32-char minimum', () => {
    const key = generateSigningKey('s1');
    expect(key.kid).toBe('s1');
    expect(key.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(key.secret, 'base64url')).toHaveLength(32);
  });

  it('does not repeat', () => {
    expect(generateSigningKey('s1').secret).not.toBe(generateSigningKey('s1').secret);
  });
});

describe('nextSigningKid', () => {
  it('starts at s1 and increments past the highest existing', () => {
    expect(nextSigningKid([])).toBe('s1');
    expect(nextSigningKid([{ kid: 's1', secret: 'x' }])).toBe('s2');
    expect(
      nextSigningKid([
        { kid: 's3', secret: 'x' },
        { kid: 's1', secret: 'x' },
      ]),
    ).toBe('s4');
  });

  it('ignores kids that are not of the s<N> form', () => {
    expect(nextSigningKid([{ kid: 'legacy', secret: 'x' }])).toBe('s1');
  });
});
