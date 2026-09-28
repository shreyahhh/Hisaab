import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { createAuth } from '@truepath/auth';
import { createAuditLogRepository, createDb } from '@truepath/db';
import { createShopifyAdapter } from '@truepath/integrations';
import { createCredentialsCipher, createIdentityHasher } from '@truepath/privacy';
import {
  apiPortEnvSchema,
  authCookieEnvSchema,
  authEnvSchema,
  clickhouseEnvSchema,
  credentialsKeyEnvSchema,
  dpaEnvSchema,
  identityKeyEnvSchema,
  loadDotEnvIfPresent,
  loadEnv,
  postgresEnvSchema,
  redisCacheEnvSchema,
  redisDurableEnvSchema,
  SHOPIFY_OAUTH_SCOPES,
  shopifyEnvSchema,
} from '@truepath/shared';
import { createAuditService } from './audit.js';
import { buildApp } from './app.js';

// Core API (Fastify): auth, tenants, integrations, reports, DPDP endpoints, webhooks (SPEC §10,
// §4). buildApp() (app.ts) wires the routes; this file is the one place that turns validated env
// into real infrastructure clients and starts listening (deploy-prerequisite issues #2/#3).

// The identity/credentials keys and DPA_VERSION have no default: without them the API refuses to
// start (privacy-dpdp.md §4.1, §4.10; ADR-0023).
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
  .and(authCookieEnvSchema);

function main(): void {
  loadDotEnvIfPresent('../../.env');
  const env = loadEnv(apiEnvSchema);

  const db = createDb(env.DATABASE_URL);
  const hasher = createIdentityHasher(env.identityKeys);
  const cipher = createCredentialsCipher(env.credentialsKeys);

  // Durable Redis backs the rate limiter and the Shopify OAuth-state nonce store (HLD §8); Better
  // Auth opens its own connection to the same URL internally (packages/auth/src/betterAuth.ts).
  // Low retry/timeout so an outage errors fast instead of hanging a request (ADR-0019).
  const redisDurable = new Redis(env.REDIS_DURABLE_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
  });
  // Not yet consumed by any route (the report cache lands with reporting-api, M3) — opened here so
  // a misconfigured REDIS_CACHE_URL still fails boot loudly rather than silently at first use.
  const redisCache = new Redis(env.REDIS_CACHE_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    lazyConnect: true,
  });
  void redisCache.connect().catch((error: unknown) => {
    console.error(JSON.stringify({ event: 'redis_cache_connect_failed', message: String(error) }));
  });

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
    // Only ever relaxes the cookie outside production — createAuth() itself throws if this is true
    // under NODE_ENV=production, so a deploy that forgets to leave this unset fails closed.
    allowInsecureCookies: env.AUTH_ALLOW_INSECURE_COOKIES,
  });

  const shopifyAdapter = createShopifyAdapter({
    clientId: env.SHOPIFY_CLIENT_ID,
    clientSecret: env.SHOPIFY_CLIENT_SECRET,
    clientSecretPrevious: env.SHOPIFY_CLIENT_SECRET_PREVIOUS,
    scopes: SHOPIFY_OAUTH_SCOPES,
  });

  const app = buildApp({
    db,
    auth,
    trustedOrigin: env.DASHBOARD_URL,
    audit: createAuditService(createAuditLogRepository(db)),
    rateLimit: { redis: redisDurable, hasher },
    dpaVersion: env.DPA_VERSION,
    shopify: {
      adapter: shopifyAdapter,
      cipher,
      hasher,
      redis: redisDurable,
      oauthStateSecret: env.SHOPIFY_OAUTH_STATE_SECRET,
      appUrl: env.SHOPIFY_APP_URL,
      dashboardUrl: env.DASHBOARD_URL,
    },
    // No proxy in front of this process in local dev: leaving trustProxy unset (false) means
    // request.ip is the direct socket address, which is correct for a bare `tsx watch` process.
    // A real deployment sets this to the ALB's VPC CIDR (issue #3) — a value only that environment
    // knows, so it can't be hardcoded here.
    trustProxy: false,
  });

  app
    .listen({ port: env.API_PORT, host: '0.0.0.0' })
    .then((address) => {
      console.log(
        `apps/api: listening on ${address} (NODE_ENV=${env.NODE_ENV}, dashboard origin=${env.DASHBOARD_URL}, insecure cookies=${env.AUTH_ALLOW_INSECURE_COOKIES})`,
      );
    })
    .catch((error: unknown) => {
      console.error(JSON.stringify({ event: 'api_listen_failed', message: String(error) }));
      process.exit(1);
    });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
