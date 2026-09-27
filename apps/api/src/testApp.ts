import { Redis } from 'ioredis';
import { createAuth, type Auth } from '@truepath/auth';
import { createAuditLogRepository, createDb, type Db } from '@truepath/db';
import { createShopifyAdapter } from '@truepath/integrations';
import { createTestCredentialsCipher, createTestIdentityHasher } from '@truepath/privacy/testing';
import { loadDotEnvIfPresent, loadEnv, postgresEnvSchema } from '@truepath/shared';
import { createAuditService } from './audit.js';
import { buildApp, type AppDeps, type ShopifyDeps } from './app.js';

// Shared real-Postgres/real-Redis test wiring for this app's own tests (CLAUDE.md: tenancy-touching
// tests run against the real local Docker databases, not mocks). Not exported outside this package.

loadDotEnvIfPresent('../../.env');
const env = loadEnv(postgresEnvSchema);

export const testDb: Db = createDb(env.DATABASE_URL);

export const testAuth: Auth = createAuth({
  db: testDb,
  env: {
    BETTER_AUTH_SECRET: 'a'.repeat(32),
    BETTER_AUTH_URL: 'http://localhost:3000',
    DASHBOARD_URL: 'http://localhost:5173',
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  },
  redisDurableUrl: 'redis://localhost:6379',
  allowInsecureCookies: true, // plain-HTTP inject() in tests
});

// Durable Redis, with low retry/timeout so an outage errors fast instead of hanging a request.
export const testRedis = new Redis('redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  connectTimeout: 500,
});

export const testAudit = createAuditService(createAuditLogRepository(testDb));

// Random keys, per test process, never written anywhere.
export const testHasher = createTestIdentityHasher();

// The DPA version the test apps require; tests accept exactly this string.
export const TEST_DPA_VERSION = 'test-1';

export const testShopifyAdapter = createShopifyAdapter({
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  scopes: ['read_orders', 'write_pixels', 'read_customer_events'],
});

export const testCredentialsCipher = createTestCredentialsCipher();

export const TEST_SHOPIFY_APP_URL = 'http://localhost:3000';
export const TEST_DASHBOARD_URL = 'http://localhost:5173';
export const TEST_SHOPIFY_OAUTH_STATE_SECRET = 'a'.repeat(32);

export const testShopify: ShopifyDeps = {
  adapter: testShopifyAdapter,
  cipher: testCredentialsCipher,
  hasher: testHasher,
  redis: testRedis,
  oauthStateSecret: TEST_SHOPIFY_OAUTH_STATE_SECRET,
  appUrl: TEST_SHOPIFY_APP_URL,
  dashboardUrl: TEST_DASHBOARD_URL,
};

export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  return buildApp({
    db: testDb,
    auth: testAuth,
    trustedOrigin: 'http://localhost:5173',
    rateLimit: { redis: testRedis, hasher: testHasher },
    dpaVersion: TEST_DPA_VERSION,
    shopify: testShopify,
    ...overrides,
  });
}
