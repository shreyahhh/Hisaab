import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { purposeContext, type IdentityHasher } from '@truepath/privacy';

// Rate limiting for our own routes. Better Auth's limiter only wraps its HTTP handler, and our
// routes call `auth.api.*` directly, which skips it — so signup, login and invite-accept were
// unthrottled until this (ADR-0019). Counters live on the durable Redis (`noeviction`), so a
// counter is never evicted early, only expired by its TTL.
//
// No raw identifier is stored: keys carry an HMAC of the IP (and of the login email), never the
// value itself (CLAUDE.md: no raw phone/email/IP at rest). Better Auth's own `ba:` keys for its
// handler routes do embed the IP; that is upstream behaviour we don't control.
//
// The HMACs come from packages/privacy's hasher, under platform purposes (`rate_limit_ip`,
// `rate_limit_email`) that are deliberately unlinkable to any store's identity hashes. Only the
// hasher's WRITE version is used (`hmac`, never `hmacAll`): a counter is a short-lived window, not
// a record to look up across key versions. After a key rotation the new version starts fresh
// counters, i.e. a client's window resets once — bounded by the window (at most an hour).

export interface RateLimitDeps {
  /** ioredis client on the DURABLE Redis. Build it with a low `maxRetriesPerRequest`/`connectTimeout` so an outage errors fast. */
  readonly redis: Redis;
  /** Pseudonymises IPs/emails in Redis keys (write version only). */
  readonly hasher: IdentityHasher;
  /** Defaults to `'rl:'`. Tests give each Vitest worker its own, so parallel workers' counters never collide (issue #11). */
  readonly nameSpace?: string;
}

interface Limit {
  readonly max: number;
  readonly timeWindow: string;
}

// Better Auth's own auth-route limit is 10 per 60 s per IP (auth-tenancy.md §7); login also gets a
// tighter per-account limits (a 5/min burst window and a 20/hour slow-guessing window) so a
// distributed guessing run against one account is capped too. Per-account limits allow a targeted
// lockout of a known email; ADR-0019 accepts that trade-off.
export const LIMITS = {
  signup: { ip: { max: 10, timeWindow: '1 minute' } },
  login: {
    ip: { max: 10, timeWindow: '1 minute' },
    email: { max: 5, timeWindow: '1 minute' },
    emailHourly: { max: 20, timeWindow: '1 hour' },
  },
  inviteAccept: { ip: { max: 10, timeWindow: '1 minute' } },
} as const satisfies Record<string, Record<string, Limit>>;

const IP_CONTEXT = purposeContext('rate_limit_ip');
const EMAIL_CONTEXT = purposeContext('rate_limit_email');

function rateLimitedBody(ttlMs: number) {
  return { statusCode: 429, error: 'rate_limited', retryAfterSeconds: Math.ceil(ttlMs / 1000) };
}

/** Registers the plugin (global: false — only routes/limiters that opt in are limited). */
export async function registerRateLimit(app: FastifyInstance, deps: RateLimitDeps): Promise<void> {
  await app.register(fastifyRateLimit, {
    global: false,
    redis: deps.redis,
    nameSpace: deps.nameSpace ?? 'rl:',
    // skipOnError stays false: if the durable Redis is unreachable the request errors instead of
    // going unthrottled (fail closed, like Better Auth's own limiter — auth-tenancy.md §5).
    skipOnError: false,
    errorResponseBuilder: (_request, context) => rateLimitedBody(context.ttl),
  });
}

/** Per-route config that limits by IP; the caller spreads it into the route's `config`. */
export function ipLimit(deps: RateLimitDeps, name: string, limit: Limit) {
  return {
    rateLimit: {
      max: limit.max,
      timeWindow: limit.timeWindow,
      keyGenerator: (request: FastifyRequest) =>
        `${name}:ip:${deps.hasher.hmac(IP_CONTEXT, fastifyRateLimit.normalizeIP(request.ip))}`,
    },
  };
}

export interface EmailWindow {
  /** Distinct per window: it is part of the Redis key. */
  readonly name: string;
  readonly limit: Limit;
}

/**
 * Login's per-account limiter, one counter per window. Needs the parsed body, so it is called from
 * the handler rather than an `onRequest` hook. Windows are checked in order and the first one
 * exceeded replies 429 (so an attempt blocked by an earlier window doesn't count against later
 * ones). Returns true if the request may proceed; otherwise it has already replied 429.
 */
export function createEmailLimiter(
  app: FastifyInstance,
  deps: RateLimitDeps,
  windows: readonly EmailWindow[],
) {
  const checks = windows.map(({ name, limit }) =>
    app.createRateLimit({
      max: limit.max,
      timeWindow: limit.timeWindow,
      keyGenerator: (request: FastifyRequest) => {
        const email = (request.body as { email?: unknown } | undefined)?.email;
        // Anything that isn't a usable address can't log in anyway; it shares one bucket instead of
        // minting a Redis key per garbage value.
        const hashed =
          typeof email === 'string' ? deps.hasher.hashEmail(EMAIL_CONTEXT, email) : null;
        return `${name}:email:${hashed ?? 'invalid'}`;
      },
    }),
  );
  return async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    for (const check of checks) {
      const result = await check(request);
      if (!result.isAllowed && result.isExceeded) {
        await reply
          .code(429)
          .header('retry-after', String(result.ttlInSeconds))
          .send(rateLimitedBody(result.ttl));
        return false;
      }
    }
    return true;
  };
}

/** What the route modules receive; built once in app.ts, after the plugin has loaded. */
export interface RouteLimits {
  readonly signupIp: ReturnType<typeof ipLimit>;
  readonly loginIp: ReturnType<typeof ipLimit>;
  readonly inviteAcceptIp: ReturnType<typeof ipLimit>;
  readonly loginEmail: ReturnType<typeof createEmailLimiter>;
}
