import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import {
  isKeyVersion,
  MIN_MASTER_KEY_BYTES,
  type CredentialsKeyConfig,
  type KeyVersion,
} from '@truepath/shared';

// Envelope encryption for `integrations.encrypted_credentials` (ADR-0023). A distinct concern from
// packages/privacy's hasher: this is reversible (AES-256-GCM), keyed by CREDENTIALS_MASTER_* rather
// than IDENTITY_MASTER_*, so compromising one secret family never helps with the other.

const HKDF_SALT = 'truepath-credentials';
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** What binds a ciphertext to the row it belongs to (ADR-0023): moving it elsewhere must fail to decrypt. */
export interface CredentialsContext {
  readonly integrationId: string;
}

function additionalData(context: CredentialsContext, version: KeyVersion): Buffer {
  return Buffer.from(`${context.integrationId}:${version}`, 'utf8');
}

export interface CredentialsCipher {
  readonly writeVersion: KeyVersion;
  /** Encrypts `plaintext` (typically a JSON-serialised credentials object) under the write version. */
  encrypt(context: CredentialsContext, plaintext: string): Buffer;
  /**
   * Decrypts an envelope produced by `encrypt`. Throws — never returns garbage — if the envelope is
   * malformed, was sealed under a key version this process can't read, or `context` doesn't match
   * what it was sealed under (e.g. moved to another integration's row).
   */
  decrypt(context: CredentialsContext, envelope: Buffer): string;
}

/**
 * Builds the cipher from validated key config (`credentialsKeyEnvSchema` in @truepath/shared). Throws
 * — naming the problem, never a key — if the config is unusable.
 */
export function createCredentialsCipher(config: CredentialsKeyConfig): CredentialsCipher {
  const { writeVersion, readVersions } = config;
  if (!isKeyVersion(writeVersion)) throw new Error('credentials keys: invalid write version');
  if (readVersions.length === 0) throw new Error('credentials keys: no read versions configured');
  if (!readVersions.includes(writeVersion)) {
    throw new Error('credentials keys: the write version must be one of the read versions');
  }
  const masters = new Map<KeyVersion, Buffer>();
  for (const version of readVersions) {
    if (!isKeyVersion(version)) throw new Error('credentials keys: invalid read version');
    const key = config.masterKeys[version];
    if (!key || key.length < MIN_MASTER_KEY_BYTES) {
      throw new Error(
        `credentials keys: master key for ${version} is missing or shorter than ${MIN_MASTER_KEY_BYTES} bytes`,
      );
    }
    masters.set(version, Buffer.from(key));
  }

  const derivedKeys = new Map<KeyVersion, Buffer>();
  function derive(version: KeyVersion): Buffer {
    let key = derivedKeys.get(version);
    if (!key) {
      const master = masters.get(version);
      if (!master) throw new Error(`credentials keys: ${version} is not a configured read version`);
      key = Buffer.from(hkdfSync('sha256', master, HKDF_SALT, version, 32));
      derivedKeys.set(version, key);
    }
    return key;
  }

  return {
    writeVersion,
    encrypt(context, plaintext) {
      const version = writeVersion;
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', derive(version), nonce);
      cipher.setAAD(additionalData(context, version));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const versionBytes = Buffer.from(version, 'ascii');
      // [1 byte version length][version][12-byte nonce][16-byte auth tag][ciphertext]
      return Buffer.concat([
        Buffer.from([versionBytes.length]),
        versionBytes,
        nonce,
        authTag,
        ciphertext,
      ]);
    },
    decrypt(context, envelope) {
      if (envelope.length < 1) throw new Error('credentials cipher: envelope too short');
      const versionLen = envelope.readUInt8(0);
      const versionEnd = 1 + versionLen;
      const nonceEnd = versionEnd + NONCE_BYTES;
      const tagEnd = nonceEnd + AUTH_TAG_BYTES;
      if (envelope.length < tagEnd) throw new Error('credentials cipher: envelope truncated');

      const version = envelope.subarray(1, versionEnd).toString('ascii');
      if (!isKeyVersion(version)) throw new Error('credentials cipher: malformed key version');
      const nonce = envelope.subarray(versionEnd, nonceEnd);
      const authTag = envelope.subarray(nonceEnd, tagEnd);
      const ciphertext = envelope.subarray(tagEnd);

      const decipher = createDecipheriv('aes-256-gcm', derive(version), nonce);
      decipher.setAAD(additionalData(context, version));
      decipher.setAuthTag(authTag);
      // GCM's tag check throws on any mismatch — wrong key, wrong nonce, wrong AAD (e.g. this
      // envelope's ciphertext moved to a different integration's row), or corrupted ciphertext.
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
  };
}
