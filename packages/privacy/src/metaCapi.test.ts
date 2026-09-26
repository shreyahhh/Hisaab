import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashContactForMetaCapi, sha256ForMetaCapi } from './metaCapi.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe("sha256ForMetaCapi follows Meta's normalisation rules", () => {
  it('em: trim, lowercase, then SHA-256', () => {
    const expected = sha256('foo.bar+tag@example.com');
    expect(sha256ForMetaCapi('em', '  Foo.Bar+Tag@Example.COM ')).toBe(expected);
    expect(sha256ForMetaCapi('em', 'foo.bar+tag@example.com')).toBe(expected);
  });

  it('ph: digits only, with country code, no plus and no leading zeros', () => {
    const expected = sha256('919753124680');
    for (const raw of ['+91 97531 24680', '097531 24680', '9753124680', '+91-97531-24680']) {
      expect(sha256ForMetaCapi('ph', raw), raw).toBe(expected);
    }
    expect(sha256ForMetaCapi('ph', '+15415550123')).toBe(sha256('15415550123'));
  });

  it('is plain, unsalted SHA-256 hex', () => {
    expect(sha256ForMetaCapi('em', 'a@b.co')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256ForMetaCapi('em', 'a@b.co')).toBe(sha256('a@b.co'));
  });

  it('returns null for unusable values, including dummy phone numbers', () => {
    expect(sha256ForMetaCapi('em', 'not an email')).toBeNull();
    expect(sha256ForMetaCapi('ph', 'junk')).toBeNull();
    expect(sha256ForMetaCapi('ph', '9999999999')).toBeNull();
    expect(sha256ForMetaCapi('ph', '9000000000')).toBeNull();
  });
});

describe('hashContactForMetaCapi', () => {
  it('returns the ph/em user_data hashes', () => {
    expect(hashContactForMetaCapi({ phone: '9753124680', email: 'A@Example.com' })).toEqual({
      ph: sha256('919753124680'),
      em: sha256('a@example.com'),
    });
  });

  it('omits what is missing or unusable', () => {
    expect(hashContactForMetaCapi({})).toEqual({});
    expect(hashContactForMetaCapi({ phone: '9999999999', email: 'a@example.com' })).toEqual({
      em: sha256('a@example.com'),
    });
  });
});
