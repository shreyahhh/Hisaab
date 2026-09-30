import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '@truepath/shared';
import { apiEnvSchema, placeholder, shouldAllowInsecureCookies } from './index.js';

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
    CREDENTIALS_KEY_READ: 'k1',
    CREDENTIALS_KEY_WRITE: 'k1',
    CREDENTIALS_MASTER_K1: key(),
    DPA_VERSION: '0.1-draft',
    SHOPIFY_CLIENT_ID: 'client-id',
    SHOPIFY_CLIENT_SECRET: 'client-secret',
    SHOPIFY_APP_URL: 'https://api.example.com',
    SHOPIFY_OAUTH_STATE_SECRET: 'a'.repeat(32),
    BETTER_AUTH_SECRET: 'b'.repeat(32),
    BETTER_AUTH_URL: 'https://api.example.com',
    DASHBOARD_URL: 'https://app.example.com',
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
    ...overrides,
  };
}

describe('apps/api', () => {
  it('exposes a placeholder as a smoke test for the build/test pipeline', () => {
    expect(placeholder()).toContain('not yet implemented');
  });
});

describe('shouldAllowInsecureCookies (issue #2)', () => {
  it('is false in production — cookies must be Secure', () => {
    expect(shouldAllowInsecureCookies('production')).toBe(false);
  });

  it('is true in development and test, for local plain-HTTP dev', () => {
    expect(shouldAllowInsecureCookies('development')).toBe(true);
    expect(shouldAllowInsecureCookies('test')).toBe(true);
  });
});

describe('apps/api boot environment', () => {
  it('accepts a complete environment', () => {
    expect(parseEnv(apiEnvSchema, env()).success).toBe(true);
  });

  it('refuses to start without DPA_VERSION or with a malformed one, in any NODE_ENV', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      expect(parseEnv(apiEnvSchema, env({ NODE_ENV, DPA_VERSION: undefined })).success).toBe(false);
      expect(parseEnv(apiEnvSchema, env({ NODE_ENV, DPA_VERSION: 'not a version' })).success).toBe(
        false,
      );
    }
  });

  it('refuses to start without the identity hash keys, in any NODE_ENV', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      for (const name of ['IDENTITY_KEY_READ', 'IDENTITY_KEY_WRITE', 'IDENTITY_MASTER_K1']) {
        const result = parseEnv(apiEnvSchema, env({ NODE_ENV, [name]: undefined }));
        expect(result.success, `${NODE_ENV} without ${name}`).toBe(false);
      }
    }
  });

  it('refuses to start without the credentials envelope keys, in any NODE_ENV (ADR-0023)', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      for (const name of [
        'CREDENTIALS_KEY_READ',
        'CREDENTIALS_KEY_WRITE',
        'CREDENTIALS_MASTER_K1',
      ]) {
        const result = parseEnv(apiEnvSchema, env({ NODE_ENV, [name]: undefined }));
        expect(result.success, `${NODE_ENV} without ${name}`).toBe(false);
      }
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
        const result = parseEnv(apiEnvSchema, env({ NODE_ENV, [name]: undefined }));
        expect(result.success, `${NODE_ENV} without ${name}`).toBe(false);
      }
    }
  });

  it('refuses to start without the Better Auth config, in any NODE_ENV', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      for (const name of [
        'BETTER_AUTH_SECRET',
        'BETTER_AUTH_URL',
        'DASHBOARD_URL',
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
      ]) {
        const result = parseEnv(apiEnvSchema, env({ NODE_ENV, [name]: undefined }));
        expect(result.success, `${NODE_ENV} without ${name}`).toBe(false);
      }
    }
  });

  it('accepts an optional COLLECTOR_PUBLIC_URL, and rejects a malformed one', () => {
    expect(
      parseEnv(apiEnvSchema, env({ COLLECTOR_PUBLIC_URL: 'https://collect.example.com' })).success,
    ).toBe(true);
    expect(parseEnv(apiEnvSchema, env({ COLLECTOR_PUBLIC_URL: 'not-a-url' })).success).toBe(false);
  });
});
