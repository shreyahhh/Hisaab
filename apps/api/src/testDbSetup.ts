import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '@truepath/db';
import { loadDotEnvIfPresent, loadEnv, postgresEnvSchema } from '@truepath/shared';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

// Vitest `setupFiles` entry (apps/api/vitest.config.ts, issue #11): gives this worker its own
// Postgres *database* (not just a schema — drizzle-kit's generated migrations schema-qualify
// every enum/FK as `"public".*`, so a different schema via `search_path` can't work without
// rewriting committed migration files, which CLAUDE.md forbids), so parallel file execution
// across workers can't see another worker's audit_log rows, users, orgs, etc. Vitest still runs
// the files *within* one worker one at a time, so one database per *worker* — not per file — is
// exactly the right grain: no two test files ever touch the same database concurrently.
//
// This must finish mutating `process.env.DATABASE_URL` before any other module in this worker
// first imports `@truepath/db/testing` or `./testApp.js` — both read `process.env.DATABASE_URL`
// lazily, at their own first import (`loadEnv`), so whichever URL is in `process.env` by then is
// what every `createDb()` call in this worker connects with. Vitest guarantees `setupFiles` run
// to completion before a test file's own imports resolve.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadDotEnvIfPresent('../../.env');
const baseUrl = loadEnv(postgresEnvSchema).DATABASE_URL;

// VITEST_POOL_ID is the stable worker index Vitest sets for the lifetime of the pool; fall back to
// '0' for a non-Vitest run (e.g. a plain `tsx` script importing this by accident) so this is never
// a hard crash outside the test runner.
const workerId = process.env.VITEST_POOL_ID ?? '0';
const dbName = `test_worker_${workerId}`;

const adminUrl = new URL(baseUrl);
const scopedUrl = new URL(baseUrl);
scopedUrl.pathname = `/${dbName}`;
process.env.DATABASE_URL = scopedUrl.toString();
// Other test helpers (Redis key prefixes, BullMQ queue prefixes) read this to stay on the same
// grain without re-deriving VITEST_POOL_ID themselves.
process.env.TEST_WORKER_ID = workerId;

// Guards against re-running CREATE DATABASE/migrate for every file Vitest hands this worker — the
// marker lives in `process.env`, which (unlike the module registry) persists across files within
// the same worker process.
if (process.env.__TEST_DB_READY !== dbName) {
  const admin = createDb(adminUrl.toString());
  try {
    const existing = await admin.execute(sql`SELECT 1 FROM pg_database WHERE datname = ${dbName}`);
    if (existing.rows.length === 0) {
      // CREATE DATABASE has no IF NOT EXISTS form, and can't run inside a transaction — a plain
      // single query over the pool (not `.transaction()`) avoids both.
      await admin.execute(sql.raw(`CREATE DATABASE "${dbName}"`));
    }
  } finally {
    await admin.$client.end();
  }

  const scoped = createDb(process.env.DATABASE_URL);
  try {
    await migrate(scoped, {
      migrationsFolder: path.resolve(__dirname, '../../../packages/db/migrations'),
    });
  } finally {
    await scoped.$client.end();
  }
  process.env.__TEST_DB_READY = dbName;
}
