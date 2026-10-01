import { defineConfig } from 'vitest/config';

// issue #11: these tests share one Postgres and one durable Redis, and some assert on global
// state (the audit_log, the login rate-limit buckets — including the one bucket every unusable
// email shares). `testDbSetup.ts` gives each worker its own Postgres *database* (so audit_log/
// users/orgs/etc. are never visible across workers) and `testApp.ts` gives each worker its own
// Redis key prefixes (our rate limiter, Better Auth, the BullMQ test queues) — files within one
// worker still run one at a time (Vitest's own model), so per-*worker* isolation is the right
// grain.
export default defineConfig({
  test: {
    setupFiles: ['./src/testDbSetup.ts'],
    // Runs once in the main process, after every worker's database is no longer needed — drops
    // them, so local Postgres doesn't keep one `test_worker_<N>` database per pool id forever.
    globalSetup: ['./src/testDbTeardown.ts'],
    // A handful of tests do real, CPU/IO-heavy work (password hashing across many requests, a
    // Postgres DDL trigger) that comfortably clears Vitest's 5s default serially, but can brush
    // against it when every worker's pool is doing similarly heavy work at the same time.
    testTimeout: 10_000,
  },
});
