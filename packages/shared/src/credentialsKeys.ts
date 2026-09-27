import { z } from 'zod';
import { isKeyVersion, MIN_MASTER_KEY_BYTES, type KeyVersion } from './identityKeys.js';

// Credential-envelope-encryption key configuration (ADR-0023). A separate key family from
// IDENTITY_MASTER_* (identityKeys.ts): identity hashing and credential encryption are deliberately
// unrelated secrets, so compromising one never helps decrypt or forge the other. Same shape,
// same "no defaults, ever" rule, same rotation story (env vars read once at boot; a rotation needs
// a task restart).
//
//   CREDENTIALS_KEY_READ=k1,k2        every version this process can decrypt with
//   CREDENTIALS_KEY_WRITE=k2          the version new ciphertexts are written under (must be in READ)
//   CREDENTIALS_MASTER_K1=<base64>    one master secret per version, >= 32 random bytes

export interface CredentialsKeyConfig {
  readonly writeVersion: KeyVersion;
  readonly readVersions: readonly KeyVersion[];
  readonly masterKeys: Readonly<Record<KeyVersion, Uint8Array>>;
}

export function credentialsMasterKeyEnvName(version: KeyVersion): string {
  return `CREDENTIALS_MASTER_${version.toUpperCase()}`;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64(value: string): Uint8Array | null {
  if (value.length % 4 !== 0 || !BASE64.test(value)) return null;
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

// Issue messages name the variable and the rule, never the value: loadEnv prints them at boot.
export const credentialsKeyEnvSchema = z
  .object({
    CREDENTIALS_KEY_READ: z.string().min(1),
    CREDENTIALS_KEY_WRITE: z.string().min(1),
  })
  // The master secrets have dynamic names (CREDENTIALS_MASTER_K<N>), so the object must let them through.
  .passthrough()
  .transform((env, ctx): { credentialsKeys: CredentialsKeyConfig } => {
    const fail = (path: string, message: string): never => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
      return z.NEVER;
    };

    const readVersions: KeyVersion[] = [];
    for (const part of env.CREDENTIALS_KEY_READ.split(',').map((p) => p.trim())) {
      if (!isKeyVersion(part)) {
        return fail(
          'CREDENTIALS_KEY_READ',
          'must be a comma-separated list of versions like k1,k2',
        );
      }
      if (readVersions.includes(part)) return fail('CREDENTIALS_KEY_READ', 'lists a version twice');
      readVersions.push(part);
    }

    const writeVersion = env.CREDENTIALS_KEY_WRITE.trim();
    if (!isKeyVersion(writeVersion)) {
      return fail('CREDENTIALS_KEY_WRITE', 'must be a single version like k1');
    }
    if (!readVersions.includes(writeVersion)) {
      return fail('CREDENTIALS_KEY_WRITE', 'must also be listed in CREDENTIALS_KEY_READ');
    }

    const masterKeys: Partial<Record<KeyVersion, Uint8Array>> = {};
    for (const version of readVersions) {
      const name = credentialsMasterKeyEnvName(version);
      const raw = (env as Record<string, unknown>)[name];
      if (typeof raw !== 'string' || raw.length === 0) {
        return fail(name, 'is required for every version in CREDENTIALS_KEY_READ');
      }
      const bytes = decodeBase64(raw.trim());
      if (!bytes) return fail(name, 'must be standard base64');
      if (bytes.length < MIN_MASTER_KEY_BYTES) {
        return fail(name, `must decode to at least ${MIN_MASTER_KEY_BYTES} bytes`);
      }
      masterKeys[version] = bytes;
    }

    return {
      credentialsKeys: {
        writeVersion,
        readVersions,
        masterKeys: masterKeys as Record<KeyVersion, Uint8Array>,
      },
    };
  });
