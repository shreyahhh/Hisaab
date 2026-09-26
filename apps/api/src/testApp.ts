import { createAuth, type Auth } from '@truepath/auth';
import { createDb, type Db } from '@truepath/db';
import { loadDotEnvIfPresent, loadEnv, postgresEnvSchema } from '@truepath/shared';
import { buildApp, type AppDeps } from './app.js';

// Shared real-Postgres/real-Redis test wiring for this app's own tests (CLAUDE.md: tenancy-touching
// tests run against the real local Docker databases, not mocks). Not exported outside this package.

loadDotEnvIfPresent('../../.env');
const env = loadEnv(postgresEnvSchema);

export const testDb: Db = createDb(env.DATABASE_URL);

export const testAuth: Auth = createAuth({
  db: testDb,
  env: {
    BETTER_AUTH_SECRET: 'a'.repeat(32),
    BETTER_AUTH_URL: 'http://localhost:3000',
    DASHBOARD_URL: 'http://localhost:5173',
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  },
  redisDurableUrl: 'redis://localhost:6379',
  useSecureCookies: false,
});

export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  return buildApp({
    db: testDb,
    auth: testAuth,
    trustedOrigin: 'http://localhost:5173',
    ...overrides,
  });
}
