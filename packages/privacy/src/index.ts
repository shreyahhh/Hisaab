// Phone/email normalisers, the keyed-hash helper, log/URL redaction (SPEC §5, HLD §8 "Privacy /
// DPDP"). Every other module imports these rather than reimplementing them (CLAUDE.md rule 3).
// See docs/architecture/lld/privacy-dpdp.md. ConsentProvider and the suppression-set client land with
// the collector (M1-5). The audit-log writer is an interface here; its Postgres implementation is in
// @truepath/db.
//
// Not exported here on purpose: `@truepath/privacy/meta-capi` (plain SHA-256 for Meta), which only
// the Meta integration may import (eslint.config.js).

export const PACKAGE_NAME = '@truepath/privacy';

export { normaliseEmail, normalisePhone } from './normalise.js';
export {
  AuditMetadataError,
  isAuditAction,
  validateAuditMetadata,
  type AuditLogger,
  type AuditMetadata,
} from './audit.js';
export {
  asStoreId,
  createIdentityHasher,
  encodeHashContext,
  hashContact,
  HASH_PURPOSES,
  isVersionedHmac,
  purposeContext,
  storeContext,
  type HashContext,
  type HashedIdentity,
  type HashPurpose,
  type IdentityHasher,
  type StoreId,
  type VersionedHmac,
} from './hasher.js';
export {
  ALLOWED_QUERY_PARAMS,
  findPii,
  REDACTED,
  redactLogValue,
  sanitiseReferrer,
  sanitiseUrl,
  SENSITIVE_KEY_PATTERNS,
  type PiiFinding,
  type PiiKind,
} from './redaction.js';
export { generateIdentityMasterKey } from './generateKey.js';
export {
  createCredentialsCipher,
  type CredentialsCipher,
  type CredentialsContext,
} from './credentialsCipher.js';
