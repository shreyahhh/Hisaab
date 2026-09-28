import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  createDb,
  createIntegrationRepository,
  createStoreRepository,
  createSystemScope,
} from '@truepath/db';
import {
  loadDotEnvIfPresent,
  loadEnv,
  postgresEnvSchema,
  redisDurableEnvSchema,
  SHOPIFY_SYNC_QUEUE,
  type ShopifySyncJob,
} from '@truepath/shared';

// Local-development operator tool for the Shopify backfill (M1-3/M1-3b). Not part of the deployed
// workers service. It exists because `bulk_operations/finish` is a webhook, and a laptop can't
// receive one without a public tunnel — so locally the second half of the backfill (`bulk_result`) is
// triggered by hand once Shopify reports the operation finished.
//
//   pnpm --filter @truepath/workers dev:backfill start  <storeId> [days]
//   pnpm --filter @truepath/workers dev:backfill status <storeId>
//   pnpm --filter @truepath/workers dev:backfill apply  <storeId>
//
// It prints only non-secret state (the `settings.backfill` object, never credentials) and holds no
// credentials itself: the worker process decrypts them.

const devEnvSchema = postgresEnvSchema.and(redisDurableEnvSchema);
const COMMANDS = ['start', 'status', 'apply'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string | undefined): value is Command {
  return (COMMANDS as readonly string[]).includes(value ?? '');
}

async function main(): Promise<void> {
  const [command, storeId, daysArg] = process.argv.slice(2);
  if (!isCommand(command) || !storeId) {
    console.error('usage: dev:backfill <start|status|apply> <storeId> [days]');
    process.exitCode = 2;
    return;
  }

  loadDotEnvIfPresent('../../.env');
  const env = loadEnv(devEnvSchema);
  const db = createDb(env.DATABASE_URL);
  const scope = await createSystemScope(db, 'shopify_reconcile', {
    metadata: { store_id: storeId, mode: `dev_${command}` },
  });
  const store = await createStoreRepository(db).getById(scope, storeId);
  if (!store) {
    console.error(`no store with id ${storeId}`);
    process.exitCode = 1;
    return;
  }
  const integration = await createIntegrationRepository(db).getActiveByStore(
    scope,
    storeId,
    'shopify',
  );
  const backfill =
    ((integration?.settings ?? {}) as { backfill?: Record<string, unknown> }).backfill ?? {};

  if (command === 'status') {
    console.log(JSON.stringify({ shop: store.shopDomain, backfill }, null, 2));
    return;
  }

  const connection = new Redis(env.REDIS_DURABLE_URL, { maxRetriesPerRequest: null });
  const queue = new Queue<ShopifySyncJob>(SHOPIFY_SYNC_QUEUE, { connection });
  try {
    if (command === 'start') {
      const days = daysArg ? Number(daysArg) : 60;
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        console.error('days must be an integer between 1 and 90');
        process.exitCode = 2;
        return;
      }
      // A fresh id per manual run: the connect flow's `backfill-<storeId>` id would be a no-op
      // while a finished job with that id is still retained.
      await queue.add(
        'backfill',
        { storeId, mode: 'backfill', days },
        { jobId: `dev-backfill-${storeId}-${Date.now()}` },
      );
      console.log(`enqueued backfill (${days} days) for ${store.shopDomain}`);
      return;
    }

    const bulkOperationId = backfill.bulk_operation_id;
    if (typeof bulkOperationId !== 'string') {
      console.error('no bulk_operation_id recorded yet — run `start` and wait for the worker');
      process.exitCode = 1;
      return;
    }
    await queue.add(
      'bulk_result',
      { storeId, mode: 'bulk_result', bulkOperationId },
      { jobId: `dev-bulk-result-${Date.now()}` },
    );
    console.log(`enqueued bulk_result for ${bulkOperationId}`);
  } finally {
    await queue.close();
    connection.disconnect();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'dev:backfill failed');
      process.exitCode = 1;
    })
    .finally(() => {
      // The postgres pool would otherwise hold the process open.
      process.exit();
    });
}
