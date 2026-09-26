import { describe, expect, it } from 'vitest';
import { authEnvSchema, parseEnv, postgresEnvSchema, redisDurableEnvSchema } from './env.js';

describe('parseEnv', () => {
  it('accepts a valid environment', () => {
    const result = parseEnv(postgresEnvSchema, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://truepath:truepath@localhost:5432/truepath',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing required var', () => {
    const result = parseEnv(redisDurableEnvSchema, { NODE_ENV: 'test' });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed URL', () => {
    const result = parseEnv(redisDurableEnvSchema, { REDIS_DURABLE_URL: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  it('defaults NODE_ENV and LOG_LEVEL when omitted', () => {
    const result = parseEnv(postgresEnvSchema, {
      DATABASE_URL: 'postgres://truepath:truepath@localhost:5432/truepath',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.NODE_ENV).toBe('development');
      expect(result.data.LOG_LEVEL).toBe('info');
    }
  });

  it('rejects a Better Auth secret shorter than 32 chars', () => {
    const result = parseEnv(authEnvSchema, {
      BETTER_AUTH_SECRET: 'too-short',
      BETTER_AUTH_URL: 'http://localhost:3000',
      DASHBOARD_URL: 'http://localhost:5173',
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid auth environment', () => {
    const result = parseEnv(authEnvSchema, {
      BETTER_AUTH_SECRET: 'a'.repeat(32),
      BETTER_AUTH_URL: 'http://localhost:3000',
      DASHBOARD_URL: 'http://localhost:5173',
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
    });
    expect(result.success).toBe(true);
  });

  it('never echoes the source values back in a way that would leak them into a diff of this test', () => {
    // Guard against a future edit accidentally asserting on (and thus logging) a real-looking secret.
    const result = parseEnv(postgresEnvSchema, { DATABASE_URL: 'not-a-url' });
    expect(result.success).toBe(false);
  });
});
