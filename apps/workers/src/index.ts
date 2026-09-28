import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createDb } from '@truepath/db';
import { createShopifyAdapter } from '@truepath/integrations';
import { createCredentialsCipher, createIdentityHasher } from '@truepath/privacy';
import {
  clickhouseEnvSchema,
  credentialsKeyEnvSchema,
  identityKeyEnvSchema,
  loadDotEnvIfPresent,
  loadEnv,
  postgresEnvSchema,
  redisDurableEnvSchema,
  SHOPIFY_OAUTH_SCOPES,
  SHOPIFY_SYNC_QUEUE,
  shopifyEnvSchema,
} from '@truepath/shared';
import { createShopifySyncProcessor } from './shopifySync.js';

// BullMQ workers (HLD §8): shopify-sync is the first one built (M1-3); event-workers, ad-sync-meta,
// ad-sync-google-ads, shiprocket-sync, identity-stitch, attribution-run, capi-dispatch,
// order-status-reconcile, retention and dsr land in later milestones. No cache-Redis connection —
// that instance is only used by the API (report cache) and Better Auth rate limiting.
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
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
