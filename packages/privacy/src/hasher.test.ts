import { createHmac, hkdfSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { KeyVersion } from '@truepath/shared';
import {
  asStoreId,
  createIdentityHasher,
  encodeHashContext,
  HASH_PURPOSES,
  hashContact,
  isVersionedHmac,
  purposeContext,
  storeContext,
  type HashContext,
  type StoreId,
} from './hasher.js';
import { createTestIdentityHasher, createTestKeyConfig } from './testing.js';

const STORE_A = randomUUID();
const STORE_B = randomUUID();
const HEX = /^k[1-9]\d*:[0-9a-f]{64}$/;

describe('hmac', () => {
  it('has the k<N>:<64 hex> shape and is deterministic', () => {
    const h = createTestIdentityHasher();
    const a = h.hmac(storeContext(STORE_A), 'value');
    expect(a).toMatch(HEX);
    expect(a.startsWith('k1:')).toBe(true);
    expect(isVersionedHmac(a)).toBe(true);
    expect(h.hmac(storeContext(STORE_A), 'value')).toBe(a);
  });

  it('matches an independent HKDF + HMAC-SHA256 computation (privacy-dpdp.md §4.1)', () => {
    const config = createTestKeyConfig(['k1']);
    const h = createIdentityHasher(config);
    const master = config.masterKeys.k1;
    const derived = Buffer.from(
      hkdfSync('sha256', master ?? '', 'truepath-identity', `k1:store:${STORE_A}`, 32),
    );
    const expected = `k1:${createHmac('sha256', derived).update('+919753124680').digest('hex')}`;
    expect(h.hmac(storeContext(STORE_A), '+919753124680')).toBe(expected);
  });

  it('differs across stores: no cross-tenant joins (SPEC §7.3 rule 5)', () => {
    const h = createTestIdentityHasher();
    expect(h.hmac(storeContext(STORE_A), 'v')).not.toBe(h.hmac(storeContext(STORE_B), 'v'));
  });

  it('differs across purposes and between a purpose and a store', () => {
    const h = createTestIdentityHasher();
    const values = [
      ...HASH_PURPOSES.map((p) => h.hmac(purposeContext(p), 'v')),
      h.hmac(storeContext(STORE_A), 'v'),
    ];
    expect(new Set(values).size).toBe(values.length);
  });

  it('differs between two hashers with different master keys', () => {
    const a = createTestIdentityHasher();
    const b = createTestIdentityHasher();
    expect(a.hmac(storeContext(STORE_A), 'v')).not.toBe(b.hmac(storeContext(STORE_A), 'v'));
  });

  it('never contains the input', () => {
    const h = createTestIdentityHasher();
    expect(h.hmac(storeContext(STORE_A), 'someone@example.com')).not.toContain('someone');
  });
});

describe('contexts cannot collide', () => {
  it('encodes stores as store:<uuid> and purposes as purpose:<name>', () => {
    expect(encodeHashContext(storeContext(STORE_A))).toBe(`store:${STORE_A}`);
    for (const purpose of HASH_PURPOSES) {
      expect(encodeHashContext(purposeContext(purpose))).toBe(`purpose:${purpose}`);
    }
  });

  it('gives every purpose and a large sample of store ids distinct encodings', () => {
    const encodings = [
      ...HASH_PURPOSES.map((p) => encodeHashContext(purposeContext(p))),
      ...Array.from({ length: 500 }, () => encodeHashContext(storeContext(randomUUID()))),
    ];
    expect(new Set(encodings).size).toBe(encodings.length);
  });

  it('keeps the two alphabets disjoint: a store payload is a UUID, a purpose payload has no digits or hyphens', () => {
    for (const purpose of HASH_PURPOSES) {
      expect(purpose).toMatch(/^[a-z_]+$/);
      expect(asStoreId.bind(null, purpose)).toThrow();
    }
    expect(encodeHashContext(storeContext(STORE_A)).slice('store:'.length)).not.toContain(':');
  });

  it('refuses a store id that spells a purpose, or anything that is not a UUID', () => {
    for (const bad of [
      'purpose:rate_limit_ip',
      `${STORE_A}:extra`,
      `${STORE_A}\n`,
      '',
      ' ',
      'store:x',
      STORE_A.slice(1),
    ]) {
      expect(() => storeContext(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('re-validates hand-built contexts when hashing', () => {
    const h = createTestIdentityHasher();
    const forgedStore: HashContext = { kind: 'store', storeId: 'purpose:rate_limit_ip' as StoreId };
    const forgedPurpose = { kind: 'purpose', purpose: `x:${STORE_A}` } as unknown as HashContext;
    expect(() => h.hmac(forgedStore, 'v')).toThrow();
    expect(() => h.hmac(forgedPurpose, 'v')).toThrow();
  });

  it('treats store ids case-insensitively (one canonical form)', () => {
    const h = createTestIdentityHasher();
    expect(h.hmac(storeContext(STORE_A.toUpperCase()), 'v')).toBe(
      h.hmac(storeContext(STORE_A), 'v'),
    );
  });
});

describe('key versions and rotation', () => {
  it('writes under the write version and reads under all of them', () => {
    const h = createTestIdentityHasher(['k1', 'k2'], 'k2');
    const ctx = storeContext(STORE_A);
    expect(h.writeVersion).toBe('k2');
    expect(h.readVersions).toEqual(['k1', 'k2']);
    expect(h.hmac(ctx, 'v').startsWith('k2:')).toBe(true);
    const all = h.hmacAll(ctx, 'v');
    expect(all.map((x) => x.slice(0, 3))).toEqual(['k1:', 'k2:']);
    expect(all).toContain(h.hmac(ctx, 'v'));
  });

  it("finds data hashed before a rotation: the old-version value is in the new hasher's lookup set", () => {
    const before = createTestKeyConfig(['k1']);
    const oldHasher = createIdentityHasher(before);
    const rotated = createIdentityHasher({
      writeVersion: 'k2',
      readVersions: ['k1', 'k2'],
      masterKeys: { ...before.masterKeys, k2: createTestKeyConfig(['k2']).masterKeys.k2! },
    });
    const ctx = storeContext(STORE_A);
    const stored = oldHasher.hmac(ctx, 'v');
    expect(rotated.hmacAll(ctx, 'v')).toContain(stored);
    expect(rotated.hmac(ctx, 'v')).not.toBe(stored);
  });

  it('derives an unrelated key per version', () => {
    const h = createTestIdentityHasher(['k1', 'k2']);
    const [k1, k2] = h.hmacAll(storeContext(STORE_A), 'v');
    expect(k1?.slice(3)).not.toBe(k2?.slice(3));
  });

  const good = () => createTestKeyConfig(['k1']);
  it.each([
    ['no read versions', { ...good(), readVersions: [] as KeyVersion[] }],
    ['a write version that is not readable', { ...good(), writeVersion: 'k2' as KeyVersion }],
    ['a missing master key', { ...good(), masterKeys: {} }],
    ['a short master key', { ...good(), masterKeys: { k1: new Uint8Array(31) } }],
    [
      'a malformed version',
      { ...good(), writeVersion: 'v1' as KeyVersion, readVersions: ['v1' as KeyVersion] },
    ],
  ])('refuses to build with %s', (_label, config) => {
    expect(() => createIdentityHasher(config)).toThrow(/identity keys/);
  });

  it('never puts key material in an error', () => {
    const config = createTestKeyConfig(['k1']);
    const shortKey = new Uint8Array(config.masterKeys.k1 ?? []).slice(0, 16);
    try {
      createIdentityHasher({ ...config, masterKeys: { k1: shortKey } });
      expect.unreachable();
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).not.toContain(Buffer.from(shortKey).toString('base64'));
      expect(message).not.toContain(Buffer.from(shortKey).toString('hex'));
    }
  });
});

describe('normalising hashes (one path for every caller)', () => {
  const h = createTestIdentityHasher();
  const ctx = storeContext(STORE_A);

  it('hashes equivalent emails identically', () => {
    const expected = h.hashEmail(ctx, 'foo@example.com');
    expect(expected).not.toBeNull();
    expect(h.hashEmail(ctx, '  Foo@Example.COM\n')).toBe(expected);
    expect(h.hashEmail(ctx, 'FOO@EXAMPLE.COM')).toBe(expected);
    expect(h.hmac(ctx, 'foo@example.com')).toBe(expected);
  });

  it('hashes equivalent phone spellings identically', () => {
    const expected = h.hashPhone(ctx, '+919753124680');
    expect(expected).not.toBeNull();
    for (const raw of ['9753124680', '097531 24680', '+91 97531-24680', '919753124680']) {
      expect(h.hashPhone(ctx, raw), raw).toBe(expected);
    }
  });

  it('returns null / nothing for unusable input instead of hashing garbage', () => {
    expect(h.hashEmail(ctx, 'not an email')).toBeNull();
    expect(h.hashPhone(ctx, '9999999999')).toBeNull();
    expect(h.hashEmailAll(ctx, '')).toEqual([]);
    expect(h.hashPhoneAll(ctx, '1234567890')).toEqual([]);
  });

  it('gives one lookup value per read version', () => {
    const rotating = createTestIdentityHasher(['k1', 'k2'], 'k2');
    expect(rotating.hashEmailAll(ctx, 'a@example.com')).toHaveLength(2);
    expect(rotating.hashPhoneAll(ctx, '9753124680')).toHaveLength(2);
  });
});

describe('hashContact', () => {
  const h = createTestIdentityHasher(['k1', 'k2'], 'k2');

  it('prefers the phone hash as the identity hash', () => {
    const id = hashContact(h, STORE_A, { phone: '9753124680', email: 'a@example.com' });
    expect(id.phoneHmac).toBeDefined();
    expect(id.emailHmac).toBeDefined();
    expect(id.identityHashHmac).toBe(id.phoneHmac);
    expect(id.lookup).toHaveLength(4);
    expect(id.lookup).toContain(id.phoneHmac);
    expect(id.lookup).toContain(id.emailHmac);
  });

  it('falls back to the email when the phone is a dummy or missing', () => {
    for (const phone of [undefined, '9999999999', 'junk']) {
      const id = hashContact(h, STORE_A, { phone, email: 'a@example.com' });
      expect(id.phoneHmac).toBeUndefined();
      expect(id.identityHashHmac).toBe(id.emailHmac);
    }
  });

  it('returns no identity for unusable contact details', () => {
    const id = hashContact(h, STORE_A, { phone: '000', email: 'nope' });
    expect(id).toEqual({ lookup: [] });
  });

  it('scopes to the store and never echoes the raw values', () => {
    const a = hashContact(h, STORE_A, { phone: '9753124680', email: 'someone@example.com' });
    const b = hashContact(h, STORE_B, { phone: '9753124680', email: 'someone@example.com' });
    expect(a.identityHashHmac).not.toBe(b.identityHashHmac);
    const json = JSON.stringify(a);
    for (const raw of ['9753124680', 'someone', 'example.com']) expect(json).not.toContain(raw);
  });

  it('rejects a store id that is not a UUID', () => {
    expect(() => hashContact(h, 'store-1', { email: 'a@example.com' })).toThrow();
  });
});
