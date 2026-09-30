import { fileURLToPath } from 'node:url';
import { createDb } from '@truepath/db';
import { loadDotEnvIfPresent, loadEnv, postgresEnvSchema } from '@truepath/shared';
import { pruneWebhookDeliveries } from './webhookDeliveryPrune.js';

// Operator tool for issue #32 (`shopify_webhook_deliveries` pruning). No generic scheduled-job runner
// exists in this repo yet (webhookDeliveryPrune.ts explains why this isn't the `retention` queue or a
// new canonical one), so this is the entry point an external scheduler calls until one does.
//
//   pnpm --filter @truepath/workers dev:prune-webhook-deliveries [--days=N]   # default: 7 (SHOPIFY_WEBHOOK_DELIVERY_RETENTION_DAYS)

async function main(): Promise<void> {
  const daysArg = process.argv.slice(2).find((arg) => arg.startsWith('--days='));
  const retentionDays = daysArg ? Number(daysArg.slice('--days='.length)) : undefined;
  if (retentionDays !== undefined && (!Number.isFinite(retentionDays) || retentionDays <= 0)) {
    console.error('usage: dev:prune-webhook-deliveries [--days=N] (N must be a positive number)');
    process.exitCode = 2;
    return;
  }

  loadDotEnvIfPresent('../../.env');
  const env = loadEnv(postgresEnvSchema);
  const db = createDb(env.DATABASE_URL);

  const result = await pruneWebhookDeliveries({
    db,
    ...(retentionDays !== undefined ? { retentionDays } : {}),
    log: (line) => console.log(JSON.stringify(line)),
  });
  console.log(
    `pruned ${result.deleted} shopify_webhook_deliveries row(s) older than ${result.cutoff.toISOString()} (retention: ${result.retentionDays}d)`,
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'dev:prune-webhook-deliveries failed');
      process.exitCode = 1;
    })
    .finally(() => {
      // The postgres pool would otherwise hold the process open.
      process.exit();
    });
}
