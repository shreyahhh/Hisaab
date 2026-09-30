import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createDb } from '@truepath/db';
import {
  IDENTITY_STITCH_QUEUE,
  loadDotEnvIfPresent,
  loadEnv,
  postgresEnvSchema,
  redisDurableEnvSchema,
  type IdentityStitchJob,
} from '@truepath/shared';
import { backfillAttributionConfidence } from './attributionConfidenceBackfill.js';

// Operator tool for issue #35: backfills `orders.attribution_confidence` for every order created
// before M1-7's identity-stitching existed. One-time by nature — see
// attributionConfidenceBackfill.ts for why this isn't a recurring scheduled job.
//
//   pnpm --filter @truepath/workers dev:backfill-attribution-confidence

const devEnvSchema = postgresEnvSchema.and(redisDurableEnvSchema);

async function main(): Promise<void> {
  loadDotEnvIfPresent('../../.env');
  const env = loadEnv(devEnvSchema);
  const db = createDb(env.DATABASE_URL);
  const connection = new Redis(env.REDIS_DURABLE_URL, { maxRetriesPerRequest: null });
  const stitchQueue = new Queue<IdentityStitchJob>(IDENTITY_STITCH_QUEUE, { connection });
  try {
    const result = await backfillAttributionConfidence({
      db,
      stitchQueue,
      log: (line) => console.log(JSON.stringify(line)),
    });
    console.log(
      `enqueued ${result.enqueued} identity-stitch job(s) for orders missing attribution_confidence`,
    );
  } finally {
    await stitchQueue.close();
    connection.disconnect();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : 'dev:backfill-attribution-confidence failed',
      );
      process.exitCode = 1;
    })
    .finally(() => {
      // The postgres pool and BullMQ connection would otherwise hold the process open.
      process.exit();
    });
}
