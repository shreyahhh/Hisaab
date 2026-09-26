import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { normaliseEmail, normalisePhone } from './normalise.js';

describe('normalisePhone', () => {
  it.each([
    ['+91 97531 24680', '+919753124680'],
    ['097531 24680', '+919753124680'],
    ['919753124680', '+919753124680'],
    ['9753124680', '+919753124680'],
    ['+91-97531-24680', '+919753124680'],
    ['(97531) 24680', '+919753124680'],
    ['+14155550123', '+14155550123'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('normalises %j to %s', (raw, expected) => {
    expect(normalisePhone(raw)).toBe(expected);
  });

  it.each([
    ['empty', ''],
    ['letters only', 'call me'],
    ['too short', '98123'],
    ['9 digits', '981234567'],
    ['10 digits not starting 6-9', '1812345678'],
    ['+91 with a short number', '+91981234567'],
    ['+91 with a long number', '+9198123456789'],
    ['a 9-digit number', '919812345'],
    ['+ number over 15 digits', '+1234567890123456'],
    ['+ number under 8 digits', '+1234567'],
    ['a plus in the middle', '98123+45678'],
    ['two plusses', '++919812345678'],
  ])('returns null for %s', (_label, raw) => {
    expect(normalisePhone(raw)).toBeNull();
  });

  describe('dummy numbers are "no identifier" (SPEC v0.3)', () => {
    it.each([
      ['one repeated digit', '9999999999'],
      ['one repeated digit, with +91', '+91 88888 88888'],
      ['a repeated two-digit block', '9898989898'],
      ['a repeated block, 0-prefixed', '09898989898'],
      ['an ascending run', '9123456789'],
      ['an ascending run inside the number', '9812345678'],
      ['a descending run', '9876543210'],
      ['a descending run inside the number', '9987654321'],
      ['the platform list', '9000000000'],
      ['a foreign number with a repeated tail', '+15555555555'],
    ])('%s', (_label, raw) => {
      expect(normalisePhone(raw)).toBeNull();
    });

    it('lets a number with only a short run through', () => {
      expect(normalisePhone('9812345900')).toBe('+919812345900');
    });
  });
});

describe('normaliseEmail', () => {
  it('trims and lowercases, nothing else', () => {
    expect(normaliseEmail('  Foo.Bar+Tag@Example.COM \n')).toBe('foo.bar+tag@example.com');
  });

  it('does not strip Gmail dots or plus tags (matches Meta)', () => {
    expect(normaliseEmail('a.b+c@gmail.com')).toBe('a.b+c@gmail.com');
  });

  it.each([
    ['plus-addressing', 'user+shop@example.com'],
    ['multiple plus tags', 'user+a+b@example.com'],
    ['a subdomain', 'user@mail.eu.example.com'],
    ['a deep subdomain', 'a@b.c.d.e.example.org'],
    ['a long TLD', 'user@example.technology'],
    ['a very long TLD', `user@example.${'a'.repeat(63)}`],
    ['a hyphenated domain', 'user@my-shop.example.co.in'],
    ['an apostrophe', "o'brien@example.ie"],
    ['underscores and dots', 'first_last.name@example.com'],
    ['a numeric local part', '12345@example.com'],
    ['an address over 254 characters', `${'a'.repeat(300)}@example.com`],
  ])('accepts %s', (_label, raw) => {
    expect(normaliseEmail(raw)).not.toBeNull();
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['no @', 'user.example.com'],
    ['two @', 'a@b@example.com'],
    ['empty local part', '@example.com'],
    ['no domain', 'user@'],
    ['no dot in the domain', 'user@localhost'],
    ['a leading dot in the domain', 'user@.example.com'],
    ['a trailing dot in the domain', 'user@example.com.'],
    ['an empty label', 'user@example..com'],
    ['inner whitespace', 'us er@example.com'],
  ])('returns null for %s', (_label, raw) => {
    expect(normaliseEmail(raw)).toBeNull();
  });

  // Better Auth validates sign-up and sign-in with zod 4's z.email(). If this ever fails, a user
  // Better Auth lets in would get "no identifier" from us — in the rate limiter, a shared bucket.
  describe('never rejects anything Better Auth accepts', () => {
    const locals = [
      'a',
      'a.b',
      'a+tag',
      'a_b',
      'a-b',
      "o'brien",
      'A.B+X',
      '1234',
      'x+y+z',
      'me.you',
    ];
    const domains = [
      'example.com',
      'Example.COM',
      'mail.example.co.uk',
      'sub.domain.example.org',
      'x.museum',
      'example.technology',
      `example.${'z'.repeat(63)}`,
      'a-b.example.io',
      '1.example.com',
      'a.b.c.d.e.f.g.example.in',
    ];
    const corpus = locals.flatMap((local) => domains.map((domain) => `${local}@${domain}`));

    it('accepts every address in the corpus that zod 4 accepts', () => {
      const accepted = corpus.filter((email) => z.email().safeParse(email).success);
      expect(accepted.length).toBeGreaterThan(corpus.length / 2);
      for (const email of accepted) {
        expect(normaliseEmail(email), email).toBe(email.toLowerCase());
      }
    });
  });
});
