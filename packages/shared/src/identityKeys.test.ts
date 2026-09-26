import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadEnv, parseEnv } from './env.js';
import { identityKeyEnvSchema } from './identityKeys.js';

// Keys are random per run and never written anywhere.
const key = (bytes = 32) => randomBytes(bytes).toString('base64');

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    IDENTITY_KEY_READ: 'k1',
    IDENTITY_KEY_WRITE: 'k1',
    IDENTITY_MASTER_K1: key(),
    ...overrides,
  };
}

function issues(source: NodeJS.ProcessEnv): string[] {
  const result = parseEnv(identityKeyEnvSchema, source);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('identityKeyEnvSchema', () => {
  it('parses one version into the config the hasher takes', () => {
    const source = env();
    const result = parseEnv(identityKeyEnvSchema, source);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { identityKeys } = result.data;
    expect(identityKeys.writeVersion).toBe('k1');
    expect(identityKeys.readVersions).toEqual(['k1']);
    expect(identityKeys.masterKeys.k1).toHaveLength(32);
    expect(Buffer.from(identityKeys.masterKeys.k1 ?? []).toString('base64')).toBe(
      source.IDENTITY_MASTER_K1,
    );
  });

  it('supports a rotation window: read k1,k2, write k2', () => {
    const result = parseEnv(
      identityKeyEnvSchema,
      env({ IDENTITY_KEY_READ: 'k1, k2', IDENTITY_KEY_WRITE: 'k2', IDENTITY_MASTER_K2: key(48) }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.identityKeys.readVersions).toEqual(['k1', 'k2']);
    expect(result.data.identityKeys.writeVersion).toBe('k2');
    expect(result.data.identityKeys.masterKeys.k2).toHaveLength(48);
  });

  it('does not pass the rest of the environment through to the parsed config', () => {
    const result = parseEnv(identityKeyEnvSchema, env({ DATABASE_URL: 'postgres://x' }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.keys(result.data).sort()).toEqual(['LOG_LEVEL', 'NODE_ENV', 'identityKeys']);
  });

  it('has no default: each missing variable is an error', () => {
    for (const name of ['IDENTITY_KEY_READ', 'IDENTITY_KEY_WRITE', 'IDENTITY_MASTER_K1']) {
      expect(issues(env({ [name]: undefined })).length, name).toBeGreaterThan(0);
      expect(issues(env({ [name]: '' })).length, `${name} empty`).toBeGreaterThan(0);
    }
    expect(issues({ NODE_ENV: 'production' })).not.toEqual([]);
  });

  it('rejects a write version that is not readable', () => {
    expect(issues(env({ IDENTITY_KEY_WRITE: 'k2', IDENTITY_MASTER_K2: key() }))).toEqual([
      'IDENTITY_KEY_WRITE: must also be listed in IDENTITY_KEY_READ',
    ]);
  });

  it('requires a master secret for every readable version', () => {
    expect(issues(env({ IDENTITY_KEY_READ: 'k1,k2' }))).toEqual([
      'IDENTITY_MASTER_K2: is required for every version in IDENTITY_KEY_READ',
    ]);
  });

  it.each(['1', 'k', 'k0', 'K1', 'k01', 'k1;k2', 'k1,,k2', 'kx'])(
    'rejects the malformed version list %j',
    (value) => {
      expect(issues(env({ IDENTITY_KEY_READ: value })).length).toBeGreaterThan(0);
    },
  );

  it('rejects a version listed twice', () => {
    expect(issues(env({ IDENTITY_KEY_READ: 'k1,k1' }))).toEqual([
      'IDENTITY_KEY_READ: lists a version twice',
    ]);
  });

  it('rejects a master key shorter than 32 bytes', () => {
    expect(issues(env({ IDENTITY_MASTER_K1: key(31) }))).toEqual([
      'IDENTITY_MASTER_K1: must decode to at least 32 bytes',
    ]);
  });

  it.each(['not base64!', 'abc', 'YWJj ZGVm', 'a'.repeat(43)])(
    'rejects a master key that is not standard base64 (%j)',
    (value) => {
      expect(issues(env({ IDENTITY_MASTER_K1: value })).length).toBeGreaterThan(0);
    },
  );

  it('never puts a key value in an error message', () => {
    const tooShort = key(16);
    const messages = JSON.stringify(issues(env({ IDENTITY_MASTER_K1: tooShort })));
    expect(messages).not.toContain(tooShort);
  });

  it('composes with loadEnv, which exits the process on a missing key', () => {
    const exit = process.exit;
    const error = console.error;
    let exitCode: number | undefined;
    const logged: string[] = [];
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('exit');
    }) as typeof process.exit;
    console.error = (...args: unknown[]) => logged.push(args.join(' '));
    try {
      expect(() => loadEnv(identityKeyEnvSchema, { NODE_ENV: 'production' })).toThrow('exit');
    } finally {
      process.exit = exit;
      console.error = error;
    }
    expect(exitCode).toBe(1);
    expect(logged.join('\n')).toContain('IDENTITY_KEY_READ');
  });
});
