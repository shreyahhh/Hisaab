import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createAuth } from '@truepath/auth';
import { createClickHouseClient } from '@truepath/clickhouse';
import { createAuditLogRepository, createDb } from '@truepath/db';
import { createShopifyAdapter } from '@truepath/integrations';
import { createCredentialsCipher, createIdentityHasher } from '@truepath/privacy';
import {
  apiPortEnvSchema,
  authEnvSchema,
  clickhouseEnvSchema,
  credentialsKeyEnvSchema,
  dpaEnvSchema,
  identityKeyEnvSchema,
  IDENTITY_STITCH_QUEUE,
  loadDotEnvIfPresent,
  loadEnv,
  postgresEnvSchema,
  redisCacheEnvSchema,
  redisDurableEnvSchema,
  SHOPIFY_OAUTH_SCOPES,
  SHOPIFY_SYNC_QUEUE,
  shopifyEnvSchema,
  type IdentityStitchJob,
  type ShopifySyncJob,
} from '@truepath/shared';
import { buildApp, type AppDeps, type ShopifyDeps } from './app.js';
import { createAuditService } from './audit.js';

// Core API (Fastify): auth, tenants, integrations, reports, DPDP endpoints, webhooks (SPEC §10,
// §4). `buildApp` (app.ts) has been fully built and tested since M0-4+; this file is the
// deploy-prerequisite (issues #2-#8) that wires it to real Postgres/Redis/ClickHouse connections
// and actually binds a port, mirroring apps/workers/src/index.ts's wiring pattern.

// The identity/credentials keys and DPA_VERSION have no default: without them the API refuses to
// start (privacy-dpdp.md §4.1, §4.10; ADR-0023). COLLECTOR_PUBLIC_URL is optional (issue #45): unset
// means the pixel install step is skipped, not a boot failure.
export const apiEnvSchema = postgresEnvSchema
  .and(clickhouseEnvSchema)
  .and(redisDurableEnvSchema)
  .and(redisCacheEnvSchema)
  .and(apiPortEnvSchema)
  .and(identityKeyEnvSchema)
  .and(credentialsKeyEnvSchema)
  .and(dpaEnvSchema)
  .and(shopifyEnvSchema)
  .and(authEnvSchema)
  .and(z.object({ COLLECTOR_PUBLIC_URL: z.string().url().optional() }));

export function placeholder(): string {
  return 'apps/api not yet implemented (SPEC §12 M0-4+)';
}

/**
 * The boot-time cookie-security decision (issue #2): `createAuth` itself refuses
 * `allowInsecureCookies: true` when `NODE_ENV=production` (auth-tenancy.md §2.2), so this can never
 * actually weaken a production deploy — but pulling the decision out as a pure function makes it
 * something a test can pin down directly, rather than only relying on that throw as a backstop.
 */
export function shouldAllowInsecureCookies(nodeEnv: string): boolean {
  return nodeEnv !== 'production';
}

function main(): void {
  loadDotEnvIfPresent('../../.env');
  const env = loadEnv(apiEnvSchema);

  const db = createDb(env.DATABASE_URL);
  const clickhouse = createClickHouseClient(env);
  const cipher = createCredentialsCipher(env.credentialsKeys);
  const hasher = createIdentityHasher(env.identityKeys);
  const adapter = createShopifyAdapter({
    clientId: env.SHOPIFY_CLIENT_ID,
    clientSecret: env.SHOPIFY_CLIENT_SECRET,
    clientSecretPrevious: env.SHOPIFY_CLIENT_SECRET_PREVIOUS,
    scopes: SHOPIFY_OAUTH_SCOPES,
  });

  // Durable Redis for OAuth-state nonces (ADR-0025) and rate-limit counters (ADR-0019). A separate
  // connection with `maxRetriesPerRequest: null` backs the BullMQ Queues below, per BullMQ's own
  // requirement (mirrors apps/workers/src/index.ts).
  const redis = new Redis(env.REDIS_DURABLE_URL);
  const queueConnection = new Redis(env.REDIS_DURABLE_URL, { maxRetriesPerRequest: null });

  const auth = createAuth({
    db,
    env: {
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: env.BETTER_AUTH_URL,
      DASHBOARD_URL: env.DASHBOARD_URL,
      GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    },
    redisDurableUrl: env.REDIS_DURABLE_URL,
    allowInsecureCookies: shouldAllowInsecureCookies(env.NODE_ENV),
  });

  const shopifySyncQueue = new Queue<ShopifySyncJob>(SHOPIFY_SYNC_QUEUE, {
    connection: queueConnection,
  });
  const identityStitchQueue = new Queue<IdentityStitchJob>(IDENTITY_STITCH_QUEUE, {
    connection: queueConnection,
  });

  const shopify: ShopifyDeps = {
    adapter,
    cipher,
    hasher,
    redis,
    oauthStateSecret: env.SHOPIFY_OAUTH_STATE_SECRET,
    appUrl: env.SHOPIFY_APP_URL,
    dashboardUrl: env.DASHBOARD_URL,
    shopifySyncQueue,
    identityStitchQueue,
    ...(env.COLLECTOR_PUBLIC_URL ? { collectorUrl: env.COLLECTOR_PUBLIC_URL } : {}),
  };

  const deps: AppDeps = {
    db,
    clickhouse,
    auth,
    trustedOrigin: env.DASHBOARD_URL,
    audit: createAuditService(createAuditLogRepository(db)),
    rateLimit: { redis, hasher },
    dpaVersion: env.DPA_VERSION,
    shopify,
  };

  const app = buildApp(deps);
  app
    .listen({ port: env.API_PORT, host: '0.0.0.0' })
    .then(() => {
      console.log(`apps/api: listening on :${env.API_PORT} (NODE_ENV=${env.NODE_ENV})`);
    })
    .catch((error: unknown) => {
      console.error('apps/api: failed to start', error);
      process.exit(1);
    });

  const shutdown = (): void => {
    void app.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
