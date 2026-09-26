import { createHmac } from 'node:crypto';
import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';

// Rate limiting for our own routes. Better Auth's limiter only wraps its HTTP handler, and our
// routes call `auth.api.*` directly, which skips it — so signup, login and invite-accept were
// unthrottled until this (ADR-0019). Counters live on the durable Redis (`noeviction`), so a
// counter is never evicted early, only expired by its TTL.
//
// No raw identifier is stored: keys carry an HMAC of the IP (and of the login email), never the
// value itself (CLAUDE.md: no raw phone/email/IP at rest). Better Auth's own `ba:` keys for its
// handler routes do embed the IP; that is upstream behaviour we don't control.

export interface RateLimitDeps {
  /** ioredis client on the DURABLE Redis. Build it with a low `maxRetriesPerRequest`/`connectTimeout` so an outage errors fast. */
  readonly redis: Redis;
  /** Keys the HMAC that pseudonymises IPs/emails in Redis keys. */
  readonly keySecret: string;
}

interface Limit {
  readonly max: number;
  readonly timeWindow: string;
}

// Better Auth's own auth-route limit is 10 per 60 s per IP (auth-tenancy.md §7); login also gets a
// tighter per-account limit so a distributed guessing run against one account is capped too.
export const LIMITS = {
  signup: { ip: { max: 10, timeWindow: '1 minute' } },
  login: {
    ip: { max: 10, timeWindow: '1 minute' },
    email: { max: 5, timeWindow: '1 minute' },
  },
  inviteAccept: { ip: { max: 10, timeWindow: '1 minute' } },
} as const satisfies Record<string, Record<string, Limit>>;

function pseudonym(secret: string, label: string, value: string): string {
  return createHmac('sha256', secret)
    .update(`rl-key-v1:${label}:${value}`)
    .digest('hex')
    .slice(0, 32);
}

function rateLimitedBody(ttlMs: number) {
  return { statusCode: 429, error: 'rate_limited', retryAfterSeconds: Math.ceil(ttlMs / 1000) };
}

/** Registers the plugin (global: false — only routes/limiters that opt in are limited). */
export async function registerRateLimit(app: FastifyInstance, deps: RateLimitDeps): Promise<void> {
  await app.register(fastifyRateLimit, {
    global: false,
    redis: deps.redis,
    nameSpace: 'rl:',
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
        `${name}:ip:${pseudonym(deps.keySecret, 'ip', fastifyRateLimit.normalizeIP(request.ip))}`,
    },
  };
}

/**
 * Login's per-account limiter. Needs the parsed body, so it is called from the handler rather than
 * an `onRequest` hook. Returns true if the request may proceed; otherwise it has already replied 429.
 */
export function createEmailLimiter(
  app: FastifyInstance,
  deps: RateLimitDeps,
  name: string,
  limit: Limit,
) {
  const check = app.createRateLimit({
    max: limit.max,
    timeWindow: limit.timeWindow,
    keyGenerator: (request: FastifyRequest) => {
      const email = (request.body as { email?: unknown } | undefined)?.email;
      const normalised = typeof email === 'string' ? email.trim().toLowerCase() : '';
      return `${name}:email:${pseudonym(deps.keySecret, 'email', normalised)}`;
    },
  });
  return async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const result = await check(request);
    if (!result.isAllowed && result.isExceeded) {
      await reply
        .code(429)
        .header('retry-after', String(result.ttlInSeconds))
        .send(rateLimitedBody(result.ttl));
      return false;
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
