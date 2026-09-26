import { createHmac, hkdfSync } from 'node:crypto';
import {
  isKeyVersion,
  MIN_MASTER_KEY_BYTES,
  type IdentityKeyConfig,
  type KeyVersion,
} from '@truepath/shared';
import { normaliseEmail, normalisePhone } from './normalise.js';

// The single keyed-hash helper for the codebase (ADR-0007, privacy-dpdp.md §4.1). Every stored or
// keyed pseudonym of a shopper/user identifier — order phone/email HMACs, visitor-id HMACs, rate-limit
// keys — comes from here, so there is one key schema, one normalisation path and one rotation story.

export type VersionedHmac = `${KeyVersion}:${string}`;

const HKDF_SALT = 'truepath-identity';
const HEX_64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isVersionedHmac(value: string): value is VersionedHmac {
  const colon = value.indexOf(':');
  return colon > 0 && isKeyVersion(value.slice(0, colon)) && HEX_64.test(value.slice(colon + 1));
}

// ---- Contexts -------------------------------------------------------------------------------
// A context picks the derived key. Store hashes and platform-purpose hashes use deliberately
// unrelated keys, so a value hashed for rate limiting can never be joined to a store's identity
// hashes (and one store's hashes never to another's — SPEC §7.3 rule 5).

export type StoreId = string & { readonly __brand: 'StoreId' };

// Purposes for hashes that belong to no tenant. Add one per distinct use; never reuse a purpose.
export const HASH_PURPOSES = ['rate_limit_ip', 'rate_limit_email'] as const;
export type HashPurpose = (typeof HASH_PURPOSES)[number];

export type HashContext =
  | { readonly kind: 'store'; readonly storeId: StoreId }
  | { readonly kind: 'purpose'; readonly purpose: HashPurpose };

export function asStoreId(value: string): StoreId {
  if (!UUID.test(value)) throw new Error('asStoreId: a store id must be a UUID');
  return value.toLowerCase() as StoreId;
}

export function storeContext(storeId: StoreId | string): HashContext {
  return { kind: 'store', storeId: asStoreId(storeId) };
}

export function purposeContext(purpose: HashPurpose): HashContext {
  return { kind: 'purpose', purpose };
}

/**
 * The HKDF `info` suffix for a context: `store:<uuid>` or `purpose:<name>`. The prefix names the
 * kind, and both payloads are closed alphabets that contain no `:` (a UUID; a fixed list of
 * `[a-z_]` names), so no store id can spell a purpose's encoding or the reverse.
 */
export function encodeHashContext(context: HashContext): string {
  if (context.kind === 'store') return `store:${asStoreId(context.storeId)}`;
  if (!(HASH_PURPOSES as readonly string[]).includes(context.purpose)) {
    throw new Error('encodeHashContext: unknown hash purpose');
  }
  return `purpose:${context.purpose}`;
}

// ---- Hasher ---------------------------------------------------------------------------------

export interface IdentityHasher {
  /** IDENTITY_KEY_WRITE: the only version `hmac` and the `hash*` writers produce. */
  readonly writeVersion: KeyVersion;
  /** IDENTITY_KEY_READ (includes `writeVersion`): every version `hmacAll` covers. */
  readonly readVersions: readonly KeyVersion[];
  /** HMAC of an already-normalised value under the write version. Use for writes and for rate-limit-style keys. */
  hmac(context: HashContext, value: string): VersionedHmac;
  /** One HMAC per read version, in `readVersions` order. Use for lookups, so data hashed under an older version is found. */
  hmacAll(context: HashContext, value: string): VersionedHmac[];
  /** Normalise then hash; null when the input is not a usable email/phone (garbage is never hashed). */
  hashEmail(context: HashContext, raw: string): VersionedHmac | null;
  hashPhone(context: HashContext, raw: string): VersionedHmac | null;
  hashEmailAll(context: HashContext, raw: string): VersionedHmac[];
  hashPhoneAll(context: HashContext, raw: string): VersionedHmac[];
}

/**
 * Builds the hasher from validated key config (`identityKeyEnvSchema` in @truepath/shared). Throws —
 * naming the problem, never a key — if the config is unusable, so a service can't start without
 * working keys.
 */
export function createIdentityHasher(config: IdentityKeyConfig): IdentityHasher {
  const { writeVersion, readVersions } = config;
  if (!isKeyVersion(writeVersion)) throw new Error('identity keys: invalid write version');
  if (readVersions.length === 0) throw new Error('identity keys: no read versions configured');
  if (!readVersions.includes(writeVersion)) {
    throw new Error('identity keys: the write version must be one of the read versions');
  }
  const masters = new Map<KeyVersion, Buffer>();
  for (const version of readVersions) {
    if (!isKeyVersion(version)) throw new Error('identity keys: invalid read version');
    const key = config.masterKeys[version];
    if (!key || key.length < MIN_MASTER_KEY_BYTES) {
      throw new Error(
        `identity keys: master key for ${version} is missing or shorter than ${MIN_MASTER_KEY_BYTES} bytes`,
      );
    }
    masters.set(version, Buffer.from(key));
  }

  const derived = new Map<string, Buffer>();
  function derive(version: KeyVersion, context: HashContext): Buffer {
    const info = `${version}:${encodeHashContext(context)}`;
    let key = derived.get(info);
    if (!key) {
      const master = masters.get(version);
      if (!master) throw new Error(`identity keys: ${version} is not a configured read version`);
      key = Buffer.from(hkdfSync('sha256', master, HKDF_SALT, info, 32));
      derived.set(info, key);
    }
    return key;
  }

  function hmacUnder(version: KeyVersion, context: HashContext, value: string): VersionedHmac {
    return `${version}:${createHmac('sha256', derive(version, context)).update(value).digest('hex')}`;
  }

  const hasher: IdentityHasher = {
    writeVersion,
    readVersions,
    hmac: (context, value) => hmacUnder(writeVersion, context, value),
    hmacAll: (context, value) => readVersions.map((v) => hmacUnder(v, context, value)),
    hashEmail(context, raw) {
      const email = normaliseEmail(raw);
      return email === null ? null : hasher.hmac(context, email);
    },
    hashPhone(context, raw) {
      const phone = normalisePhone(raw);
      return phone === null ? null : hasher.hmac(context, phone);
    },
    hashEmailAll(context, raw) {
      const email = normaliseEmail(raw);
      return email === null ? [] : hasher.hmacAll(context, email);
    },
    hashPhoneAll(context, raw) {
      const phone = normalisePhone(raw);
      return phone === null ? [] : hasher.hmacAll(context, phone);
    },
  };
  return hasher;
}

// ---- Contact hashing ------------------------------------------------------------------------

export interface HashedIdentity {
  readonly phoneHmac?: VersionedHmac;
  readonly emailHmac?: VersionedHmac;
  /** phoneHmac ?? emailHmac (SPEC §7.3 rule 3). */
  readonly identityHashHmac?: VersionedHmac;
  /** Phone and email under every read version — for IN (…) lookups. */
  readonly lookup: VersionedHmac[];
}

/** Hashes a shopper's phone/email for a store. The raw values never leave this call. */
export function hashContact(
  hasher: IdentityHasher,
  storeId: StoreId | string,
  contact: { phone?: string | undefined; email?: string | undefined },
): HashedIdentity {
  const context = storeContext(storeId);
  const phoneHmac = contact.phone ? hasher.hashPhone(context, contact.phone) : null;
  const emailHmac = contact.email ? hasher.hashEmail(context, contact.email) : null;
  const identityHashHmac = phoneHmac ?? emailHmac;
  return {
    ...(phoneHmac ? { phoneHmac } : {}),
    ...(emailHmac ? { emailHmac } : {}),
    ...(identityHashHmac ? { identityHashHmac } : {}),
    lookup: [
      ...(contact.phone ? hasher.hashPhoneAll(context, contact.phone) : []),
      ...(contact.email ? hasher.hashEmailAll(context, contact.email) : []),
    ],
  };
}
