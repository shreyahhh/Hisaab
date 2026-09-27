import { z } from 'zod';
import { DPA_VERSION_PATTERN } from './dpa.js';

// Loads a local .env file into process.env, if present. No-op on Node versions without
// process.loadEnvFile (falls back to whatever the environment already set) and never throws on a
// missing/unreadable file. CI and containers set real env vars directly and have no .env
// (CLAUDE.md rule 6: real secrets come from AWS Secrets Manager, never a committed file).
export function loadDotEnvIfPresent(path = '.env'): void {
  const loadEnvFile = (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile;
  if (typeof loadEnvFile !== 'function') return;
  try {
    loadEnvFile(path);
  } catch {
    // No .env file at that path — fine, rely on the environment's own vars.
  }
}

export const commonEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

// One schema per infra concern (HLD §5/§7) — apps compose only the ones they actually connect to.
// The collector has no Postgres connection and depends only on durable Redis; cache Redis is only
// used by the API (report cache) and Better Auth rate limiting (HLD §4).
export const postgresEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
});

export const clickhouseEnvSchema = z.object({
  CLICKHOUSE_URL: z.string().url(),
  CLICKHOUSE_USER: z.string().min(1),
  CLICKHOUSE_PASSWORD: z.string().min(1),
  CLICKHOUSE_DB: z.string().min(1),
});

export const redisDurableEnvSchema = z.object({
  REDIS_DURABLE_URL: z.string().url(),
});

export const redisCacheEnvSchema = z.object({
  REDIS_CACHE_URL: z.string().url(),
});

// Explicit per-app keys, not a shared PORT: apps run from one root .env.example (§ CLAUDE.md
// commands) and must not collide when run side by side in local dev.
export const apiPortEnvSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(3000),
});

export const collectorPortEnvSchema = z.object({
  COLLECTOR_PORT: z.coerce.number().int().positive().default(3001),
});

// Better Auth config (ADR-0012, auth-tenancy.md §2.2). BETTER_AUTH_URL is this API's own base URL
// (used to build OAuth callback URLs); DASHBOARD_URL is the one trusted origin allowed to call
// auth routes with credentials.
export const authEnvSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  DASHBOARD_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
});
export type AuthEnv = z.infer<typeof authEnvSchema>;

// Local-dev-only override, separate from authEnvSchema (auth-tenancy.md §2.2's documented shape):
// Better Auth's session cookie is `Secure` by default and `createAuth` refuses this flag outright
// when NODE_ENV is "production" (packages/auth/src/betterAuth.ts), so it can only ever relax the
// cookie for a plain-http localhost dashboard, never in a deployed environment. Defaults to `false`
// (secure cookies), so an environment that never sets it behaves exactly as documented.
export const authCookieEnvSchema = z.object({
  AUTH_ALLOW_INSECURE_COOKIES: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type AuthCookieEnv = z.infer<typeof authCookieEnvSchema>;

// The DPA version tenants must have accepted before tracking is enabled (privacy-dpdp.md §4.10). No
// default on purpose: a silent default could ship a draft, unapproved DPA to production. The value
// names a text in docs/dpdp/, set by whoever deploys once counsel has approved it.
export const dpaEnvSchema = z.object({
  DPA_VERSION: z.string().regex(DPA_VERSION_PATTERN, 'must be 1-32 chars of [A-Za-z0-9._-]'),
});
export type DpaEnv = z.infer<typeof dpaEnvSchema>;

type WithCommon<Schema extends z.ZodTypeAny> = z.ZodIntersection<typeof commonEnvSchema, Schema>;

// Pure validation, no process access beyond reading `source` — this is what's unit tested.
export function parseEnv<Schema extends z.ZodTypeAny>(
  schema: Schema,
  source: NodeJS.ProcessEnv = process.env,
): z.SafeParseReturnType<z.input<WithCommon<Schema>>, z.output<WithCommon<Schema>>> {
  return commonEnvSchema.and(schema).safeParse(source);
}

// Fails fast and loud on boot (CLAUDE.md rule 6) rather than starting a service with an invalid or
// missing config. Logs only the offending field paths/messages, never process.env itself, so a
// misconfigured secret's value can never end up in boot logs.
export function loadEnv<Schema extends z.ZodTypeAny>(
  schema: Schema,
  source: NodeJS.ProcessEnv = process.env,
): z.output<WithCommon<Schema>> {
  const result = parseEnv(schema, source);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    console.error(['Invalid environment configuration:', ...issues].join('\n'));
    process.exit(1);
  }
  return result.data;
}
