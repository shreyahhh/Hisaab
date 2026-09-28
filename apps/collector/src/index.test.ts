import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '@truepath/shared';
import { collectorEnvSchema } from './index.js';

const key = () => randomBytes(32).toString('base64');

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    REDIS_DURABLE_URL: 'redis://localhost:6379',
    IDENTITY_KEY_READ: 'k1',
    IDENTITY_KEY_WRITE: 'k1',
    IDENTITY_MASTER_K1: key(),
    ...overrides,
  };
}

describe('apps/collector boot environment', () => {
  it('accepts a complete environment, and defaults the port', () => {
    const parsed = parseEnv(collectorEnvSchema, env());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.COLLECTOR_PORT).toBe(3001);
  });

  it('needs only durable Redis and the identity keys: no Postgres, no ClickHouse (collector.md §1)', () => {
    // Exactly these variables are enough: nothing about Postgres or ClickHouse is required, so a
    // Collector deployed without database credentials still boots.
    const minimal = {
      REDIS_DURABLE_URL: 'redis://localhost:6379',
      IDENTITY_KEY_READ: 'k1',
      IDENTITY_KEY_WRITE: 'k1',
      IDENTITY_MASTER_K1: key(),
    };
    expect(parseEnv(collectorEnvSchema, minimal).success).toBe(true);
  });

  it('refuses to start without the identity-hashing keys, in any NODE_ENV (it hashes every visitor id)', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      for (const name of ['IDENTITY_KEY_READ', 'IDENTITY_KEY_WRITE', 'IDENTITY_MASTER_K1']) {
        expect(
          parseEnv(collectorEnvSchema, env({ NODE_ENV, [name]: undefined })).success,
          `${NODE_ENV} without ${name}`,
        ).toBe(false);
      }
    }
  });

  it('refuses to start without a durable Redis URL', () => {
    expect(parseEnv(collectorEnvSchema, env({ REDIS_DURABLE_URL: undefined })).success).toBe(false);
  });
});
