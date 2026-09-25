import { fileURLToPath } from 'node:url';
import {
  clickhouseEnvSchema,
  loadDotEnvIfPresent,
  loadEnv,
  postgresEnvSchema,
  redisDurableEnvSchema,
} from '@truepath/shared';

// BullMQ + stream-consumer workers: event-workers, ad-sync-meta, ad-sync-google-ads,
// shiprocket-sync, shopify-sync, identity-stitch, attribution-run, capi-dispatch,
// order-status-reconcile, retention, dsr (HLD §8 job/queue registry). No cache-Redis connection —
// that Redis instance is only used by the API (report cache) and Better Auth rate limiting.
// M0-2 wires env validation at boot only.

const workersEnvSchema = postgresEnvSchema.and(clickhouseEnvSchema).and(redisDurableEnvSchema);

export function placeholder(): string {
  return 'apps/workers not yet implemented (SPEC §12 M1-6+)';
}

function main(): void {
  loadDotEnvIfPresent('../../.env');
  const env = loadEnv(workersEnvSchema);
  console.log(`apps/workers: environment OK (NODE_ENV=${env.NODE_ENV})`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
