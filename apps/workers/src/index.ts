import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createClickHouseClient } from '@truepath/clickhouse';
import { createDb, createMetaWarmupSchedulingRepository, createSystemScope } from '@truepath/db';
import { createMetaAdapter, createShopifyAdapter } from '@truepath/integrations';
import { createCredentialsCipher, createIdentityHasher } from '@truepath/privacy';
import {
  AD_SYNC_META_QUEUE,
  ATTRIBUTION_RUN_QUEUE,
  clickhouseEnvSchema,
  consentDefaultOnEnvSchema,
  credentialsKeyEnvSchema,
  dpaEnvSchema,
  DSR_QUEUE,
  IDENTITY_STITCH_QUEUE,
  identityKeyEnvSchema,
  loadDotEnvIfPresent,
  loadEnv,
  META_WARMUP_INTERVAL_MS,
  metaWarmupSchedulerId,
  postgresEnvSchema,
  redisDurableEnvSchema,
  SHOPIFY_OAUTH_SCOPES,
  SHOPIFY_SYNC_QUEUE,
  shopifyEnvSchema,
  uuidV7,
  type AdSyncMetaJob,
  type AttributionRunJob,
  type DsrJob,
  type IdentityStitchJob,
} from '@truepath/shared';
import { processEventBatch } from './eventBatch.js';
import { EventConsumer } from './eventConsumer.js';
import { attachDeadLetter } from './deadLetter.js';
import { createDsrFailureHandler, createDsrProcessor } from './dsr/worker.js';
import { createIdentityStitchProcessor } from './identity/stitch.js';
import { runMetaWarmup } from './metaWarmup.js';
import { createShopifySyncProcessor } from './shopifySync.js';
import { StoreContextCache } from './storeEventContext.js';
import { SuppressionRebuilder } from './suppressionRebuild.js';

// Workers (HLD §8): shopify-sync (M1-3), event-workers (M1-6, the `stream:events-raw` consumer group),
// identity-stitch (M1-7), the `meta-warmup` slice of ad-sync-meta (M1-8) and `dsr` (`erasure` and
// `store_erasure`, issue #25) are built; the rest of ad-sync-meta, ad-sync-google-ads,
// shiprocket-sync, attribution-run (enqueued to by identity-stitch and `dsr`; its consumer is M3-2),
// capi-dispatch, order-status-reconcile and retention land in later milestones. No cache-Redis
// connection — that instance is only used by the API (report cache) and Better Auth rate limiting.
export const workersEnvSchema = postgresEnvSchema
  .and(clickhouseEnvSchema)
  .and(redisDurableEnvSchema)
  .and(credentialsKeyEnvSchema)
  .and(identityKeyEnvSchema)
  .and(shopifyEnvSchema)
  // The DPA version a store's organization must have accepted for its collector config to be `active`
  // (republished by the suppression rebuild, #56) — the same variable the API requires.
  .and(dpaEnvSchema)
  // Issue #52: the default-on-region evaluator's auto-pause feature flag.
  .and(consentDefaultOnEnvSchema);

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

  // Everything else runs on `redis` (pipelines, acks, key reads); `reader` only ever runs the blocking
  // XREADGROUP of event-workers.
  const clickhouse = createClickHouseClient(env);
  const redis = new Redis(env.REDIS_DURABLE_URL);
  const reader = new Redis(env.REDIS_DURABLE_URL, { maxRetriesPerRequest: null });
  const log = (line: Record<string, unknown>): void => console.log(JSON.stringify(line));

  const dsrQueue = new Queue<DsrJob>(DSR_QUEUE, { connection });
  const identityStitchQueue = new Queue<IdentityStitchJob>(IDENTITY_STITCH_QUEUE, { connection });
  const attributionQueue = new Queue<AttributionRunJob>(ATTRIBUTION_RUN_QUEUE, { connection });

  const worker = new Worker(
    SHOPIFY_SYNC_QUEUE,
    createShopifySyncProcessor({ db, adapter, cipher, hasher, redis, identityStitchQueue }),
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

  // identity-stitch (M1-7): links each order to its visitor(s), then hands it to attribution (whose
  // consumer lands with M3-2). A job's last failure is copied to `identity-stitch-failed` (HLD §8).
  const stitchWorker = new Worker<IdentityStitchJob>(
    IDENTITY_STITCH_QUEUE,
    createIdentityStitchProcessor(
      {
        db,
        redis,
        clickhouse,
        hasher,
        now: () => new Date(),
        stitchQueue: identityStitchQueue,
        attributionQueue,
      },
      log,
    ),
    { connection },
  );
  attachDeadLetter(
    stitchWorker,
    new Queue<IdentityStitchJob>(`${IDENTITY_STITCH_QUEUE}-failed`, { connection }),
    log,
  );
  console.log('apps/workers: identity-stitch worker listening');

  // dsr (issue #25): fulfils `erasure` jobs (webhook, withdrawal and follow-up scopes) and
  // `store_erasure` (offboarding, §4.7); `access`/`correction` have no producer yet. A job's last
  // failure is copied to `dsr-failed` (HLD §8), and marks the request `status='failed'` (never
  // downgrading an already-`completed` row — a follow-up purge failing must not un-complete the
  // original erasure).
  const dsrWorker = new Worker<DsrJob>(
    DSR_QUEUE,
    createDsrProcessor(
      { db, redis, clickhouse, hasher, attributionQueue, now: () => new Date() },
      log,
    ),
    { connection },
  );
  dsrWorker.on('failed', createDsrFailureHandler({ db }));
  attachDeadLetter(dsrWorker, new Queue<DsrJob>(`${DSR_QUEUE}-failed`, { connection }), log);
  console.log('apps/workers: dsr worker listening');

  // ad-sync-meta / meta-warmup (M1-8, meta-integration.md §2.2): only the `meta-warmup` job name is
  // implemented; meta-daily/meta-intraday/meta-backfill land with M2. No shopper data is touched (LLD
  // §4.2 step 1: "Suppression isn't relevant"), so this is never paused by the rebuilder.
  const metaAdapter = createMetaAdapter();
  const metaWarmupWorker = new Worker<AdSyncMetaJob>(
    AD_SYNC_META_QUEUE,
    async (job) => {
      if (job.name !== 'meta-warmup') {
        throw new Error(`ad-sync-meta: job name '${job.name}' is not implemented yet`);
      }
      return runMetaWarmup(
        { db, clickhouse, cipher, adapter: metaAdapter, now: () => new Date(), log },
        job.data,
      );
    },
    { connection },
  );
  attachDeadLetter(
    metaWarmupWorker,
    new Queue<AdSyncMetaJob>(`${AD_SYNC_META_QUEUE}-failed`, { connection }),
    log,
  );

  // Registers the repeatable job for every store the operator has already registered an account for
  // (idempotent: `upsertJobScheduler` keys on the stable per-store scheduler id). A store registered
  // *after* boot needs `pnpm --filter @truepath/workers dev:meta-warmup start <storeId>` until this
  // list is rescanned some other way — acceptable for a handful of design-partner/test accounts in M1.
  void (async () => {
    const metaWarmupQueue = new Queue<AdSyncMetaJob>(AD_SYNC_META_QUEUE, { connection });
    const scope = await createSystemScope(db, 'scheduler_fanout', {
      metadata: { for: 'meta_warmup' },
    });
    const warmupStores = await createMetaWarmupSchedulingRepository(db).listWarmupStores(scope);
    for (const { storeId } of warmupStores) {
      await metaWarmupQueue.upsertJobScheduler(
        metaWarmupSchedulerId(storeId),
        { every: META_WARMUP_INTERVAL_MS },
        { name: 'meta-warmup', data: { storeId } },
      );
    }
    log({ event: 'meta_warmup_scheduled', stores: warmupStores.length });
  })();
  console.log('apps/workers: meta-warmup worker listening');

  // event-workers (M1-6): the `stream:events-raw` consumer group.
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
            defaultOnSignal: {
              db,
              redis,
              cipher,
              dpaVersion: env.DPA_VERSION,
              consentPauseEnabled: env.CONSENT_DEFAULT_ON_PAUSE_ENABLED,
              log,
            },
          },
          entries,
          memo,
        ),
      // Counts and error names only: nothing here may carry an entry, identifier or error message.
      log,
    },
    { consumer: `event-workers:${hostname()}-${process.pid}` },
  );

  // Keeps `suppress:ready` present (HLD §8): rebuilds the suppression sets from Postgres at startup and
  // whenever the marker goes missing. While it is missing the event consumer waits on its own, and the
  // BullMQ workers are paused here (`true`: don't wait for active jobs, which would delay the rebuild).
  const rebuilder = new SuppressionRebuilder({
    db,
    redis,
    log,
    configs: {
      cipher,
      dpaVersion: env.DPA_VERSION,
      consentPauseEnabled: env.CONSENT_DEFAULT_ON_PAUSE_ENABLED,
    },
    onUnavailable: async () => {
      await Promise.all([worker.pause(true), stitchWorker.pause(true), dsrWorker.pause(true)]);
    },
    onReady: () => {
      worker.resume();
      stitchWorker.resume();
      dsrWorker.resume();
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
