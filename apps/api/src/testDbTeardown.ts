import { createDb } from '@truepath/db';
import { loadDotEnvIfPresent, loadEnv, postgresEnvSchema } from '@truepath/shared';
import { sql } from 'drizzle-orm';

// Vitest `globalSetup` entry (apps/api/vitest.config.ts, issue #11): runs once in the main
// process, before any worker starts — so unlike testDbSetup.ts's per-worker setupFiles, it can't
// know in advance which `test_worker_<N>` databases this run will create. Its only job is the
// teardown half: after every worker has finished, drop every `test_worker_%` database this (or an
// earlier, interrupted) run left behind, so local Postgres doesn't accumulate one database per
// Vitest pool id forever.

export default async function setup(): Promise<() => Promise<void>> {
  return async function teardown() {
    loadDotEnvIfPresent('../../.env');
    const baseUrl = loadEnv(postgresEnvSchema).DATABASE_URL;
    const admin = createDb(baseUrl);
    try {
      const { rows } = await admin.execute(
        sql`SELECT datname FROM pg_database WHERE datname LIKE 'test_worker_%'`,
      );
      for (const row of rows as { datname: string }[]) {
        // Can't be run inside a transaction or while any connection to it is still open — every
        // worker's own pool closes itself (testDbSetup.ts / testApp.ts's connections) before this
        // process-level teardown fires, but a stray leftover connection makes this one drop a
        // no-op with a warning rather than fail the whole run.
        try {
          await admin.execute(sql.raw(`DROP DATABASE IF EXISTS "${row.datname}"`));
        } catch (error) {
          console.warn(
            `testDbTeardown: could not drop ${row.datname} (${error instanceof Error ? error.message : 'unknown error'})`,
          );
        }
      }
    } finally {
      await admin.$client.end();
    }
  };
}
