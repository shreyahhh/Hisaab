import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { findPii, REDACTED, redactLogValue, sanitiseReferrer, sanitiseUrl } from './redaction.js';

const HASH = 'k1:' + 'ab12'.repeat(16);

describe('redactLogValue: strings', () => {
  it.each([
    ['an email', 'login failed for someone@example.com today'],
    ['an email with a plus tag', 'sent to first.last+shop@mail.example.co.in!'],
    ['a plain Indian mobile', 'phone 9753124680 given'],
    ['a spaced Indian mobile', 'phone 97531 24680 given'],
    ['a +91 mobile', 'phone +91 97531 24680 given'],
    ['a 91-prefixed mobile', 'phone 919753124680 given'],
    ['an E.164 number', 'call +14155550123 now'],
    ['a 64-hex hash', `hash ${'0f'.repeat(32)} stored`],
    ['a versioned HMAC', `visitor ${HASH}`],
  ])('removes %s', (_label, input) => {
    const out = redactLogValue(input) as string;
    expect(out).toContain(REDACTED);
    expect(findPii(out)).toEqual([]);
  });

  it('leaves ordinary text and short ids alone', () => {
    const line = 'store 3f0c9a1e-77aa-4d1b-9c0e-0a1b2c3d4e5f order 1042 took 35ms status=204';
    expect(redactLogValue(line)).toBe(line);
  });

  it('accepts (and documents) 10-digit order numbers starting 6-9 as false positives', () => {
    expect(redactLogValue('order 9000012345')).toBe(`order ${REDACTED}`);
  });
});

describe('redactLogValue: IDENTITY_MASTER_*', () => {
  const key = randomBytes(32).toString('base64');

  it('redacts the value of any IDENTITY_MASTER_* key, whatever it holds', () => {
    const out = redactLogValue({
      IDENTITY_MASTER_K1: key,
      identity_master_k2: 'x',
      IDENTITY_MASTER_K10: 12,
      IDENTITY_KEY_WRITE: 'k1',
    }) as Record<string, unknown>;
    expect(out.IDENTITY_MASTER_K1).toBe(REDACTED);
    expect(out.identity_master_k2).toBe(REDACTED);
    expect(out.IDENTITY_MASTER_K10).toBe(REDACTED);
    expect(out.IDENTITY_KEY_WRITE).toBe('k1');
    expect(JSON.stringify(out)).not.toContain(key);
  });

  it('redacts the assignment when an env dump is logged as text', () => {
    for (const text of [
      `IDENTITY_MASTER_K1=${key}`,
      `env: IDENTITY_MASTER_K2: ${key}, NODE_ENV: test`,
      `{"IDENTITY_MASTER_K1":"${key}"}`,
    ]) {
      const out = redactLogValue(text) as string;
      expect(out, text).not.toContain(key);
      expect(out).toContain(REDACTED);
    }
  });

  it('redacts an entire process.env-shaped object', () => {
    const env = { NODE_ENV: 'production', IDENTITY_MASTER_K1: key, IDENTITY_KEY_READ: 'k1' };
    expect(JSON.stringify(redactLogValue(env))).not.toContain(key);
  });
});

describe('redactLogValue: structures', () => {
  it('redacts identifier and credential keys by name', () => {
    const out = redactLogValue({
      email: 'a@example.com',
      attemptedEmail: 'a@example.com',
      phone: '1',
      ip: '1.2.3.4',
      ipAddress: '1.2.3.4',
      userAgent: 'x',
      visitor_id: 'v',
      password: 'p',
      authorization: 'Bearer x',
      cookie: 'c',
      sessionToken: 't',
      apiKey: 'k',
      storeId: 's',
      status: 204,
    }) as Record<string, unknown>;
    const kept = Object.entries(out).filter(([, v]) => v !== REDACTED);
    expect(Object.fromEntries(kept)).toEqual({ storeId: 's', status: 204 });
  });

  it('walks nested objects and arrays', () => {
    const out = redactLogValue({
      request: { headers: [{ cookie: 'x' }], note: 'mail me at a@example.com' },
      list: ['fine', '9753124680'],
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain('a@example.com');
    expect(json).not.toContain('9753124680');
    expect(json).toContain('fine');
  });

  it('redacts inside an Error, message and stack, and keeps its name', () => {
    const out = redactLogValue(new TypeError('bad address a@example.com')) as {
      name: string;
      message: string;
      stack?: string;
    };
    expect(out.name).toBe('TypeError');
    expect(out.message).toBe(`bad address ${REDACTED}`);
    expect(out.stack ?? '').not.toContain('a@example.com');
  });

  it('never returns key bytes', () => {
    expect(redactLogValue({ blob: randomBytes(32) })).toEqual({ blob: '[redacted binary]' });
  });

  it('survives circular references and deep nesting', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(redactLogValue(a)).toEqual({ name: 'a', self: '[circular]' });
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(redactLogValue(deep))).toContain('[truncated]');
  });

  it('does not mutate its input', () => {
    const input = { email: 'a@example.com', nested: { note: '9753124680' } };
    redactLogValue(input);
    expect(input).toEqual({ email: 'a@example.com', nested: { note: '9753124680' } });
  });

  it('passes primitives and dates through', () => {
    const when = new Date(0);
    expect(redactLogValue({ n: 1, b: true, z: null, when })).toEqual({
      n: 1,
      b: true,
      z: null,
      when,
    });
  });
});

describe('findPii (the log-scan primitive, SPEC §5.10 test 4)', () => {
  it('finds each kind and reports offsets, never the matched text', () => {
    const text = `a@example.com then 9753124680 then ${'ab'.repeat(32)} then IDENTITY_MASTER_K1=xyz`;
    const findings = findPii(text);
    expect(findings.map((f) => f.kind).sort()).toEqual(['email', 'hash', 'phone', 'secret']);
    expect(JSON.stringify(findings)).not.toContain('example.com');
  });

  it('finds nothing in clean text', () => {
    expect(findPii('POST /v1/auth/login 401 in 12ms store=abc')).toEqual([]);
  });

  it('finds nothing in the redacted form of a realistic mix of log records', () => {
    const records = [
      { msg: 'login failed', email: 'someone@example.com', ip: '203.0.113.9' },
      { msg: 'order webhook', customer: { phone: '+91 97531 24680', email: 'x@y.co' } },
      { err: new Error('duplicate key for a.b+c@example.org'), hash: HASH },
      'raw line: contact 9753124680 or someone@example.com, key IDENTITY_MASTER_K1=abc',
    ];
    for (const record of records) {
      expect(findPii(JSON.stringify(record)).length, JSON.stringify(record)).toBeGreaterThan(0);
      expect(findPii(JSON.stringify(redactLogValue(record))), JSON.stringify(record)).toEqual([]);
    }
  });
});

describe('sanitiseUrl (collector.md §4 step 9)', () => {
  it('keeps scheme, host, path and only the allow-listed query params', () => {
    expect(
      sanitiseUrl(
        'https://shop.example.com/products/tee?utm_source=meta&utm_medium=cpc&utm_campaign=c1&utm_content=ad&utm_term=t&fbclid=F&gclid=G&gbraid=GB&wbraid=WB',
      ),
    ).toBe(
      'https://shop.example.com/products/tee?utm_source=meta&utm_medium=cpc&utm_campaign=c1&utm_content=ad&utm_term=t&fbclid=F&gclid=G&gbraid=GB&wbraid=WB',
    );
  });

  it('drops everything else: email, phone, search terms, unknown params', () => {
    expect(
      sanitiseUrl(
        'https://shop.example.com/search?q=shoes&email=a%40example.com&phone=9753124680&utm_source=x&customer_id=1',
      ),
    ).toBe('https://shop.example.com/search?utm_source=x');
  });

  it('drops the fragment and any userinfo', () => {
    expect(sanitiseUrl('https://user:pass@shop.example.com/a#access_token=abc')).toBe(
      'https://shop.example.com/a',
    );
  });

  it('keeps a non-default port', () => {
    expect(sanitiseUrl('http://localhost:3000/x?utm_source=a')).toBe(
      'http://localhost:3000/x?utm_source=a',
    );
  });

  it.each([
    ['/checkouts/cn/abc123token/information', '/checkouts/:token'],
    ['/checkouts/c/abc123', '/checkouts/:token'],
    ['/orders/9f8e7d6c5b4a', '/orders/:token'],
    ['/account/orders/1042', '/account/:token'],
    ['/cart/c/wsdefg?key=1', '/cart/c/:token'],
    ['/en-in/checkouts/cn/abc', '/en-in/checkouts/:token'],
  ])('masks the token in %s', (path, expected) => {
    const out = sanitiseUrl(`https://shop.example.com${path}`);
    expect(out).toBe(`https://shop.example.com${expected}`);
  });

  it('leaves a bare token prefix and ordinary paths alone', () => {
    expect(sanitiseUrl('https://shop.example.com/cart')).toBe('https://shop.example.com/cart');
    expect(sanitiseUrl('https://shop.example.com/collections/orders-sale')).toBe(
      'https://shop.example.com/collections/orders-sale',
    );
  });

  it.each([
    '',
    'not a url',
    'javascript:alert(1)',
    'ftp://shop.example.com/x',
    '//shop.example.com',
  ])('returns an empty string for %j', (input) => {
    expect(sanitiseUrl(input)).toBe('');
  });
});

describe('sanitiseReferrer', () => {
  it('keeps origin and path only', () => {
    expect(sanitiseReferrer('https://www.google.com/search?q=my+name&hl=en#x')).toBe(
      'https://www.google.com/search',
    );
  });

  it('masks tokens in the path too', () => {
    expect(
      sanitiseReferrer('https://shop.example.com/checkouts/cn/abc/thank-you?utm_source=x'),
    ).toBe('https://shop.example.com/checkouts/:token');
  });

  it('returns an empty string for a non-URL', () => {
    expect(sanitiseReferrer('')).toBe('');
    expect(sanitiseReferrer('android-app://com.instagram.android')).toBe('');
  });
});
