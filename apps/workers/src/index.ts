import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createClickHouseClient } from '@truepath/clickhouse';
import { createDb } from '@truepath/db';
import { createShopifyAdapter } from '@truepath/integrations';
import { createCredentialsCipher, createIdentityHasher } from '@truepath/privacy';
import {
  clickhouseEnvSchema,
  credentialsKeyEnvSchema,
  DSR_QUEUE,
  identityKeyEnvSchema,
  loadDotEnvIfPresent,
  loadEnv,
  postgresEnvSchema,
  redisDurableEnvSchema,
  SHOPIFY_OAUTH_SCOPES,
  SHOPIFY_SYNC_QUEUE,
  shopifyEnvSchema,
  uuidV7,
  type DsrJob,
} from '@truepath/shared';
import { processEventBatch } from './eventBatch.js';
import { EventConsumer } from './eventConsumer.js';
import { createShopifySyncProcessor } from './shopifySync.js';
import { StoreContextCache } from './storeEventContext.js';
import { SuppressionRebuilder } from './suppressionRebuild.js';

// Workers (HLD §8): shopify-sync (M1-3) and event-workers (M1-6, the `stream:events-raw` consumer
// group) are built; ad-sync-meta, ad-sync-google-ads, shiprocket-sync, identity-stitch,
// attribution-run, capi-dispatch, order-status-reconcile, retention and dsr land in later milestones
// (the `dsr` queue is enqueued to by event-workers but has no consumer until M4-2). No cache-Redis
// connection — that instance is only used by the API (report cache) and Better Auth rate limiting.
export const workersEnvSchema = postgresEnvSchema
  .and(clickhouseEnvSchema)
  .and(redisDurableEnvSchema)
  .and(credentialsKeyEnvSchema)
  .and(identityKeyEnvSchema)
  .and(shopifyEnvSchema);

function main(): void {
  loadDotEnvIfPresent('../../.env');
  const env = loadEnv(workersEnvSchema);

  const db = createDb(env.DATABASE_URL);
  const cipher = createCredentialsCipher(env.credentialsKeys);
  const hasher = createIdentityHasher(env.identityKeys);
  const adapter = createShopifyAdapter({
    clientId: env.SHOPIFY_CLIENT_ID,
    clientSecret: env.SHOPIFY_CLIENT_SECRET,
    clientSecretPrevious: env.SHOPIFY_CLIENT_SECRET_PREVIOUS,
    scopes: SHOPIFY_OAUTH_SCOPES,
  });

  // A dedicated connection: BullMQ's Worker issues blocking commands and requires
  // maxRetriesPerRequest: null on the client it uses (its own docs) — this must not be shared with
  // a connection that expects the normal retry-then-fail behaviour.
  const connection = new Redis(env.REDIS_DURABLE_URL, { maxRetriesPerRequest: null });

  const worker = new Worker(
    SHOPIFY_SYNC_QUEUE,
    createShopifySyncProcessor({ db, adapter, cipher, hasher }),
    { connection },
  );

  worker.on('failed', (job, error) => {
    console.error(
      JSON.stringify({
        event: 'shopify_sync_job_failed',
        job_id: job?.id,
        mode: job?.data?.mode,
        message: error.message,
      }),
    );
  });

  console.log(`apps/workers: shopify-sync worker listening (NODE_ENV=${env.NODE_ENV})`);

  // event-workers (M1-6): the `stream:events-raw` consumer group. `reader` only ever runs the blocking
  // XREADGROUP; `redis` does everything else (pipelines, acks, reclaim).
  const clickhouse = createClickHouseClient(env);
  const redis = new Redis(env.REDIS_DURABLE_URL);
  const reader = new Redis(env.REDIS_DURABLE_URL, { maxRetriesPerRequest: null });
  const dsrQueue = new Queue<DsrJob>(DSR_QUEUE, { connection });
  const stores = new StoreContextCache(db);
  const consumer = new EventConsumer(
    {
      reader,
      redis,
      process: (entries, memo) =>
        processEventBatch(
          {
            redis,
            clickhouse,
            db,
            hasher,
            dsrQueue,
            stores,
            now: () => new Date(),
            newSessionId: () => uuidV7(Date.now(), randomBytes(16)),
          },
          entries,
          memo,
        ),
      // Counts and error names only: nothing here may carry an entry, identifier or error message.
      log: (line) => console.log(JSON.stringify(line)),
    },
    { consumer: `event-workers:${hostname()}-${process.pid}` },
  );

  // Keeps `suppress:ready` present (HLD §8): rebuilds the suppression sets from Postgres at startup and
  // whenever the marker goes missing. While it is missing the event consumer waits on its own, and the
  // shopify-sync queue is paused here (`true`: don't wait for active jobs, which would delay the rebuild).
  const rebuilder = new SuppressionRebuilder({
    db,
    redis,
    log: (line) => console.log(JSON.stringify(line)),
    onUnavailable: async () => {
      await worker.pause(true);
    },
    onReady: () => {
      worker.resume();
    },
  });

  process.once('SIGTERM', () => {
    consumer.stop();
    rebuilder.stop();
  });
  process.once('SIGINT', () => {
    consumer.stop();
    rebuilder.stop();
  });
  rebuilder.start();
  void runEventWorkers(consumer);
  console.log('apps/workers: event-workers consumer group and suppression rebuilder started');
}

/**
 * Keeps the consumer alive across an unexpected failure (e.g. a dropped Redis connection). Entries it
 * had read but not acknowledged stay pending and are reclaimed after 60 s.
 */
async function runEventWorkers(consumer: EventConsumer): Promise<void> {
  let stopped = false;
  process.once('SIGTERM', () => (stopped = true));
  process.once('SIGINT', () => (stopped = true));
  while (!stopped) {
    try {
      await consumer.run();
      return;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'event_consumer_crashed',
          error_name: error instanceof Error ? error.name : 'unknown',
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
