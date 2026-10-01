import { fileURLToPath } from 'node:url';
import { createClickHouseClient } from '@truepath/clickhouse';
import { createDb } from '@truepath/db';
import { Redis } from 'ioredis';
import {
  clickhouseEnvSchema,
  loadDotEnvIfPresent,
  loadEnv,
  postgresEnvSchema,
  redisDurableEnvSchema,
} from '@truepath/shared';
import { runOrgDeletionScheduler } from './orgDeletionScheduler.js';

// Operator tool for issue #84 (org deletion's erasure scheduler, auth-tenancy.md §4.6 steps 4-5). No
// generic scheduled-job runner exists in this repo yet (orgDeletionScheduler.ts explains why this
// isn't the `retention` queue or a new canonical one), so this is the entry point an external
// scheduler calls until one does.
//
//   pnpm --filter @truepath/workers dev:erase-overdue-orgs

async function main(): Promise<void> {
  loadDotEnvIfPresent('../../.env');
  const env = loadEnv(postgresEnvSchema.and(clickhouseEnvSchema).and(redisDurableEnvSchema));
  const db = createDb(env.DATABASE_URL);
  const clickhouse = createClickHouseClient(env);
  const redis = new Redis(env.REDIS_DURABLE_URL);

  const result = await runOrgDeletionScheduler({
    db,
    clickhouse,
    redis,
    log: (line) => console.log(JSON.stringify(line)),
  });
  console.log(
    `org-deletion sweep: ${result.organizationsErased} erased, ${result.organizationsFailed} failed, ${result.overdueCount} overdue`,
  );
  redis.disconnect();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'dev:erase-overdue-orgs failed');
      process.exitCode = 1;
    })
    .finally(() => {
      // The postgres pool would otherwise hold the process open.
      process.exit();
    });
}
