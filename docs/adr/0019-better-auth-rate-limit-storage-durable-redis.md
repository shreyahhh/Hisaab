# 0019. Better Auth rate-limit storage: durable Redis, not cache Redis

## Status
Accepted (2026-09-25; supersedes the rate-limit-storage placement in Accepted ADR-0012 and HLD §8)

## Context
ADR-0012's decision text and HLD §8 both place Better Auth's rate-limit counters (prefix `ba:`) on
the **cache** Redis instance (`allkeys-lru`, no persistence — HLD §4/§8). That instance exists so a
disposable report cache can be evicted under memory pressure without consequence.

Rate-limit counters are not disposable in the same sense: if the cache instance evicts a `ba:`
counter early under memory pressure, the next request for that key is treated as the *first*
request in a fresh window — rate limiting for that key silently stops working until the counter is
recreated and fills up again. This is a real gap for exactly the requests rate limiting exists to
slow down (repeated sign-in attempts): an attacker generating enough other cache traffic (or simply
riding along on a busy cache) could get a wider effective window than configured.

## Decision
Better Auth's rate-limit `secondaryStorage` (`@better-auth/redis-storage`, `keyPrefix: 'ba:'`) is
configured against the **durable** Redis instance (AOF, `noeviction`), not the cache instance.
`createAuth`'s option is named `redisDurableUrl`, not `redisCacheUrl` (`packages/auth/src/betterAuth.ts`).

This does not risk unbounded growth on the durable instance: `@better-auth/redis-storage` sets a
Redis `EXPIRE`/`SETEX` TTL on every key it writes (`increment()` via `EXPIRE key <window>` on the
counter's first write; `set()` via `SETEX` when a TTL is given) — confirmed by inspecting
`@better-auth/redis-storage@1.7.6`'s implementation, not assumed from its README. A `ba:` counter
is bounded by the rate-limit window regardless of which instance holds it; `noeviction` only means
it can't disappear *before* that TTL expires.

## Consequences
- `packages/auth`'s `CreateAuthOptions.redisDurableUrl` replaces `redisCacheUrl`; callers
  (`apps/api/src/testApp.ts`, `packages/auth/src/betterAuth.test.ts`) pass the durable Redis URL.
- HLD §8's "Redis (cache)" bullet no longer lists Better Auth rate-limit counters under `ba:`; that
  line moves to "Redis (durable)". `auth-tenancy.md` §2.2/§5 are updated to match.
- The cache Redis instance's role is now exactly "report query cache" (HLD §4) — no security-load-
  bearing state lives there, matching its `allkeys-lru` eviction policy.
- Verified in `packages/auth/src/betterAuth.test.ts`'s rate-limit test, and manually against the
  real local durable Redis: a live `ba:127.0.0.1|/sign-in/email` key with a positive `TTL` appears
  on the durable instance (port 6379) during the test, not the cache instance (port 6380).
