import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { createIdentityHasher, shopifyCustomerPrivacyProvider } from '@truepath/privacy';
import {
  collectorPortEnvSchema,
  identityKeyEnvSchema,
  loadDotEnvIfPresent,
  loadEnv,
  redisDurableEnvSchema,
} from '@truepath/shared';
import { buildCollectorApp } from './app.js';
import { nullGeo } from './geo.js';
import { DEFAULT_IP_LIMIT, DEFAULT_STORE_LIMIT, TokenBucketLimiter } from './rateLimit.js';
import { StoreConfigCache } from './storeConfig.js';

// Ingest collector (Fastify): POST /v1/collect — validation, consent gate, hashing, suppression check,
// geo, stream write (SPEC §7.2, HLD §5; collector.md). Stateless, and depends only on durable Redis: it
// holds no Postgres connection and never reads or writes ClickHouse.

export const collectorEnvSchema = redisDurableEnvSchema
  .and(collectorPortEnvSchema)
  .and(identityKeyEnvSchema);

async function main(): Promise<void> {
  loadDotEnvIfPresent('../../.env');
  const env = loadEnv(collectorEnvSchema);

  // Commands fail fast when Redis is down (no offline queue, one retry) so a request gets its 503
  // in milliseconds rather than hanging behind a reconnect — the pixel does not retry anyway.
  const redis = new Redis(env.REDIS_DURABLE_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2_000,
  });
  redis.on('error', () => {
    // Connection errors surface as 503s on the requests that hit them; the client's own error
    // event would otherwise print a message that can contain the connection URL.
  });

  const app = buildCollectorApp({
    redis,
    storeConfigs: new StoreConfigCache(redis),
    hasher: createIdentityHasher(env.identityKeys),
    consent: shopifyCustomerPrivacyProvider,
    geo: nullGeo,
    ipLimiter: new TokenBucketLimiter(DEFAULT_IP_LIMIT),
    storeLimiter: new TokenBucketLimiter(DEFAULT_STORE_LIMIT),
    now: Date.now,
  });

  await app.listen({ port: env.COLLECTOR_PORT, host: '0.0.0.0' });
  console.log(
    `apps/collector: listening on :${env.COLLECTOR_PORT} (NODE_ENV=${env.NODE_ENV}, geo=${nullGeo.source ?? 'off'})`,
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'collector failed to start');
    process.exit(1);
  });
}
