import { z } from 'zod';

// Identity-hashing key configuration (privacy-dpdp.md §4.1, ADR-0007). Master secrets are injected
// as env vars — in deployed environments by ECS from Secrets Manager (`truepath/identity-master/k<N>`),
// locally from .env — and there is deliberately NO default: a service that can't load its keys
// must not start, because hashing under a guessable or empty key is worse than not hashing.
//
//   IDENTITY_KEY_READ=k1,k2          every version this process can read (lookups use all of them)
//   IDENTITY_KEY_WRITE=k2            the version new hashes are written under (must be in READ)
//   IDENTITY_MASTER_K1=<base64>      one master secret per version, >= 32 random bytes
//
// Env vars are read once at boot, so rotating keys requires restarting the tasks.

export type KeyVersion = `k${number}`;

export const KEY_VERSION_PATTERN = /^k[1-9]\d{0,3}$/;
export const MIN_MASTER_KEY_BYTES = 32;

export interface IdentityKeyConfig {
  readonly writeVersion: KeyVersion;
  readonly readVersions: readonly KeyVersion[];
  readonly masterKeys: Readonly<Record<KeyVersion, Uint8Array>>;
}

export function isKeyVersion(value: string): value is KeyVersion {
  return KEY_VERSION_PATTERN.test(value);
}

export function masterKeyEnvName(version: KeyVersion): string {
  return `IDENTITY_MASTER_${version.toUpperCase()}`;
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
export const identityKeyEnvSchema = z
  .object({
    IDENTITY_KEY_READ: z.string().min(1),
    IDENTITY_KEY_WRITE: z.string().min(1),
  })
  // The master secrets have dynamic names (IDENTITY_MASTER_K<N>), so the object must let them through.
  .passthrough()
  .transform((env, ctx): { identityKeys: IdentityKeyConfig } => {
    const fail = (path: string, message: string): never => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
      return z.NEVER;
    };

    const readVersions: KeyVersion[] = [];
    for (const part of env.IDENTITY_KEY_READ.split(',').map((p) => p.trim())) {
      if (!isKeyVersion(part)) {
        return fail('IDENTITY_KEY_READ', 'must be a comma-separated list of versions like k1,k2');
      }
      if (readVersions.includes(part)) return fail('IDENTITY_KEY_READ', 'lists a version twice');
      readVersions.push(part);
    }

    const writeVersion = env.IDENTITY_KEY_WRITE.trim();
    if (!isKeyVersion(writeVersion)) {
      return fail('IDENTITY_KEY_WRITE', 'must be a single version like k1');
    }
    if (!readVersions.includes(writeVersion)) {
      return fail('IDENTITY_KEY_WRITE', 'must also be listed in IDENTITY_KEY_READ');
    }

    const masterKeys: Partial<Record<KeyVersion, Uint8Array>> = {};
    for (const version of readVersions) {
      const name = masterKeyEnvName(version);
      const raw = (env as Record<string, unknown>)[name];
      if (typeof raw !== 'string' || raw.length === 0) {
        return fail(name, 'is required for every version in IDENTITY_KEY_READ');
      }
      const bytes = decodeBase64(raw.trim());
      if (!bytes) return fail(name, 'must be standard base64');
      if (bytes.length < MIN_MASTER_KEY_BYTES) {
        return fail(name, `must decode to at least ${MIN_MASTER_KEY_BYTES} bytes`);
      }
      masterKeys[version] = bytes;
    }

    return {
      identityKeys: {
        writeVersion,
        readVersions,
        masterKeys: masterKeys as Record<KeyVersion, Uint8Array>,
      },
    };
  });
