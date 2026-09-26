import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '@truepath/shared';
import { apiEnvSchema, placeholder } from './index.js';

const key = () => randomBytes(32).toString('base64');

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    CLICKHOUSE_URL: 'http://localhost:8123',
    CLICKHOUSE_USER: 'u',
    CLICKHOUSE_PASSWORD: 'p',
    CLICKHOUSE_DB: 'd',
    REDIS_DURABLE_URL: 'redis://localhost:6379',
    REDIS_CACHE_URL: 'redis://localhost:6380',
    IDENTITY_KEY_READ: 'k1',
    IDENTITY_KEY_WRITE: 'k1',
    IDENTITY_MASTER_K1: key(),
    ...overrides,
  };
}

describe('apps/api', () => {
  it('exposes a placeholder as a smoke test for the build/test pipeline', () => {
    expect(placeholder()).toContain('not yet implemented');
  });
});

describe('apps/api boot environment', () => {
  it('accepts a complete environment', () => {
    expect(parseEnv(apiEnvSchema, env()).success).toBe(true);
  });

  it('refuses to start without the identity hash keys, in any NODE_ENV', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      for (const name of ['IDENTITY_KEY_READ', 'IDENTITY_KEY_WRITE', 'IDENTITY_MASTER_K1']) {
        const result = parseEnv(apiEnvSchema, env({ NODE_ENV, [name]: undefined }));
        expect(result.success, `${NODE_ENV} without ${name}`).toBe(false);
      }
    }
  });
});
