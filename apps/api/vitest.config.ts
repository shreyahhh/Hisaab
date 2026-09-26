import { defineConfig } from 'vitest/config';

// These tests share one Postgres and one durable Redis, and some assert on global state (the
// audit_log, the login rate-limit buckets — including the one bucket every unusable email shares).
// Running files one at a time keeps them from seeing each other's rows and counters.
export default defineConfig({
  test: { fileParallelism: false },
});
