import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createAuth, type Auth } from '@truepath/auth';
import { createClickHouseClient } from '@truepath/clickhouse';
import { createAuditLogRepository, createDb, type Db } from '@truepath/db';
import { createShopifyAdapter } from '@truepath/integrations';
import { createTestCredentialsCipher, createTestIdentityHasher } from '@truepath/privacy/testing';
import {
  clickhouseEnvSchema,
  DSR_QUEUE,
  loadDotEnvIfPresent,
  loadEnv,
  postgresEnvSchema,
  IDENTITY_STITCH_QUEUE,
  SHOPIFY_SYNC_QUEUE,
  type DsrJob,
  type IdentityStitchJob,
  type ShopifySyncJob,
} from '@truepath/shared';
import { createAuditService } from './audit.js';
import { buildApp, type AppDeps, type ShopifyDeps } from './app.js';

// Shared real-Postgres/real-Redis test wiring for this app's own tests (CLAUDE.md: tenancy-touching
// tests run against the real local Docker databases, not mocks). Not exported outside this package.

loadDotEnvIfPresent('../../.env');
const env = loadEnv(postgresEnvSchema.and(clickhouseEnvSchema));

export const testDb: Db = createDb(env.DATABASE_URL);
export const testClickhouse = createClickHouseClient(env);

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

// A dedicated connection: BullMQ's own docs require a Queue's ioredis client not share
// maxRetriesPerRequest settings with unrelated code, and this way closing it (if a test ever
// needs to) can't affect testRedis.
const testQueueRedis = new Redis('redis://localhost:6379', { maxRetriesPerRequest: null });
// The queue keeps its canonical name (HLD §8) but lives under its own BullMQ key prefix, so a real
// `shopify-sync` worker running against this same local Redis (e.g. `pnpm dev`) can never consume,
// lock or race the jobs these tests enqueue and then assert on.
export const testShopifySyncQueue = new Queue<ShopifySyncJob>(SHOPIFY_SYNC_QUEUE, {
  connection: testQueueRedis,
  prefix: 'bull-test',
});

// Same isolation for identity-stitch: a real stitch worker on this Redis must never consume these jobs.
export const testIdentityStitchQueue = new Queue<IdentityStitchJob>(IDENTITY_STITCH_QUEUE, {
  connection: testQueueRedis,
  prefix: 'bull-test',
});

// Same isolation for dsr: a real dsr worker on this Redis must never consume these jobs.
export const testDsrQueue = new Queue<DsrJob>(DSR_QUEUE, {
  connection: testQueueRedis,
  prefix: 'bull-test',
});

export const testShopify: ShopifyDeps = {
  adapter: testShopifyAdapter,
  cipher: testCredentialsCipher,
  hasher: testHasher,
  redis: testRedis,
  oauthStateSecret: TEST_SHOPIFY_OAUTH_STATE_SECRET,
  appUrl: TEST_SHOPIFY_APP_URL,
  dashboardUrl: TEST_DASHBOARD_URL,
  shopifySyncQueue: testShopifySyncQueue,
  identityStitchQueue: testIdentityStitchQueue,
  dsrQueue: testDsrQueue,
};

export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  return buildApp({
    db: testDb,
    clickhouse: testClickhouse,
    auth: testAuth,
    trustedOrigin: 'http://localhost:5173',
    rateLimit: { redis: testRedis, hasher: testHasher },
    dpaVersion: TEST_DPA_VERSION,
    shopify: testShopify,
    ...overrides,
  });
}
