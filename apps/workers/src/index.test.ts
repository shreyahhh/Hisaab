import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '@truepath/shared';
import { workersEnvSchema } from './index.js';

const key = () => randomBytes(32).toString('base64');

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    CLICKHOUSE_URL: 'http://localhost:8123',
    CLICKHOUSE_USER: 'u',
    CLICKHOUSE_PASSWORD: 'p',
    CLICKHOUSE_DB: 'd',
    REDIS_DURABLE_URL: 'redis://localhost:6379',
    CREDENTIALS_KEY_READ: 'k1',
    CREDENTIALS_KEY_WRITE: 'k1',
    CREDENTIALS_MASTER_K1: key(),
    IDENTITY_KEY_READ: 'k1',
    IDENTITY_KEY_WRITE: 'k1',
    IDENTITY_MASTER_K1: key(),
    SHOPIFY_CLIENT_ID: 'client-id',
    SHOPIFY_CLIENT_SECRET: 'client-secret',
    SHOPIFY_APP_URL: 'https://api.example.com',
    SHOPIFY_OAUTH_STATE_SECRET: 'a'.repeat(32),
    DPA_VERSION: 'v1',
    ...overrides,
  };
}

describe('apps/workers boot environment', () => {
  it('accepts a complete environment', () => {
    expect(parseEnv(workersEnvSchema, env()).success).toBe(true);
  });

  it('refuses to start without the credentials envelope keys, in any NODE_ENV (ADR-0023)', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      for (const name of [
        'CREDENTIALS_KEY_READ',
        'CREDENTIALS_KEY_WRITE',
        'CREDENTIALS_MASTER_K1',
      ]) {
        const result = parseEnv(workersEnvSchema, env({ NODE_ENV, [name]: undefined }));
        expect(result.success, `${NODE_ENV} without ${name}`).toBe(false);
      }
    }
  });

  it('refuses to start without the identity-hashing keys, in any NODE_ENV (ADR-0007)', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      for (const name of ['IDENTITY_KEY_READ', 'IDENTITY_KEY_WRITE', 'IDENTITY_MASTER_K1']) {
        const result = parseEnv(workersEnvSchema, env({ NODE_ENV, [name]: undefined }));
        expect(result.success, `${NODE_ENV} without ${name}`).toBe(false);
      }
    }
  });

  it('refuses to start without the DPA version the collector config gates on (#56)', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      const result = parseEnv(workersEnvSchema, env({ NODE_ENV, DPA_VERSION: undefined }));
      expect(result.success, `${NODE_ENV} without DPA_VERSION`).toBe(false);
    }
  });

  it('refuses to start without the Shopify OAuth config, in any NODE_ENV', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      for (const name of [
        'SHOPIFY_CLIENT_ID',
        'SHOPIFY_CLIENT_SECRET',
        'SHOPIFY_APP_URL',
        'SHOPIFY_OAUTH_STATE_SECRET',
      ]) {
        const result = parseEnv(workersEnvSchema, env({ NODE_ENV, [name]: undefined }));
        expect(result.success, `${NODE_ENV} without ${name}`).toBe(false);
      }
    }
  });
});
