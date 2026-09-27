import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { credentialsKeyEnvSchema } from './credentialsKeys.js';
import { parseEnv } from './env.js';

// Mirrors identityKeys.test.ts — same schema shape, a distinct key family (ADR-0023).

const key = (bytes = 32) => randomBytes(bytes).toString('base64');

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    CREDENTIALS_KEY_READ: 'k1',
    CREDENTIALS_KEY_WRITE: 'k1',
    CREDENTIALS_MASTER_K1: key(),
    ...overrides,
  };
}

function issues(source: NodeJS.ProcessEnv): string[] {
  const result = parseEnv(credentialsKeyEnvSchema, source);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('credentialsKeyEnvSchema', () => {
  it('parses one version into the config the credential cipher takes', () => {
    const source = env();
    const result = parseEnv(credentialsKeyEnvSchema, source);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { credentialsKeys } = result.data;
    expect(credentialsKeys.writeVersion).toBe('k1');
    expect(credentialsKeys.readVersions).toEqual(['k1']);
    expect(credentialsKeys.masterKeys.k1).toHaveLength(32);
  });

  it('supports a rotation window: read k1,k2, write k2', () => {
    const result = parseEnv(
      credentialsKeyEnvSchema,
      env({
        CREDENTIALS_KEY_READ: 'k1,k2',
        CREDENTIALS_KEY_WRITE: 'k2',
        CREDENTIALS_MASTER_K2: key(48),
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.credentialsKeys.readVersions).toEqual(['k1', 'k2']);
    expect(result.data.credentialsKeys.writeVersion).toBe('k2');
  });

  it('is independent of IDENTITY_KEY_* — setting only the identity keys is still an error', () => {
    expect(
      issues({
        NODE_ENV: 'test',
        IDENTITY_KEY_READ: 'k1',
        IDENTITY_KEY_WRITE: 'k1',
        IDENTITY_MASTER_K1: key(),
      }).length,
    ).toBeGreaterThan(0);
  });

  it('has no default: each missing variable is an error', () => {
    for (const name of ['CREDENTIALS_KEY_READ', 'CREDENTIALS_KEY_WRITE', 'CREDENTIALS_MASTER_K1']) {
      expect(issues(env({ [name]: undefined })).length, name).toBeGreaterThan(0);
    }
  });

  it('rejects a write version that is not readable', () => {
    expect(issues(env({ CREDENTIALS_KEY_WRITE: 'k2', CREDENTIALS_MASTER_K2: key() }))).toEqual([
      'CREDENTIALS_KEY_WRITE: must also be listed in CREDENTIALS_KEY_READ',
    ]);
  });

  it('rejects a master key shorter than 32 bytes', () => {
    expect(issues(env({ CREDENTIALS_MASTER_K1: key(31) }))).toEqual([
      'CREDENTIALS_MASTER_K1: must decode to at least 32 bytes',
    ]);
  });

  it('rejects a master key that is not standard base64', () => {
    expect(issues(env({ CREDENTIALS_MASTER_K1: 'not base64!' })).length).toBeGreaterThan(0);
  });

  it('never puts a key value in an error message', () => {
    const tooShort = key(16);
    const messages = JSON.stringify(issues(env({ CREDENTIALS_MASTER_K1: tooShort })));
    expect(messages).not.toContain(tooShort);
  });
});
