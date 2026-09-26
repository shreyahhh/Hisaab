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

## The durable instance must really be `noeviction`
This decision is only as good as the instance's eviction policy, so it is stated as a requirement,
not an assumption:
- **Local:** `docker-compose.yml`'s `redis-durable` runs `--appendonly yes --maxmemory-policy
  noeviction`; confirmed live with `CONFIG GET maxmemory-policy` → `noeviction` (the cache instance
  reports `allkeys-lru`, as intended). `maxmemory` is unset locally, so the policy only bites once a
  limit exists.
- **AWS (deployment requirement):** the ElastiCache durable cluster's parameter group must set
  `maxmemory-policy noeviction` explicitly — ElastiCache's default is `volatile-lru`, which *can*
  evict TTL'd keys (every `ba:` counter and our own `rl:` counters carry a TTL) under memory
  pressure. Verify with `CONFIG GET maxmemory-policy` after provisioning.
- **Failure mode is closed, by design (see Accepted trade-offs):** under `noeviction`, a full instance rejects writes instead
  of dropping counters, so rate-limited routes error rather than silently going unthrottled. Memory
  on this instance therefore needs an alert well below `maxmemory` (it also carries the event
  stream and BullMQ queues, HLD §4).

## Our own routes are rate-limited separately, on the same instance
Better Auth's limiter only wraps its HTTP handler; `auth.api.*` server calls skip it (verified:
15 direct `signInEmail` calls never returned 429). Our `POST /v1/auth/signup|login` and
`POST /v1/invites/:token/accept` call `auth.api.*` directly, so `apps/api` rate-limits them itself
with `@fastify/rate-limit` on this same durable Redis (prefix `rl:`; keys hold an HMAC of the IP —
and of the email for login — never the raw value). Limits: 10/min per IP on each route, plus 5/min
per email on login, plus a second per-email window of 20/hour (a slow guesser that waits out the
minute still hits a ceiling). Known gap we don't control: Better Auth's own `ba:<ip>|<path>`
counters (for its `/v1/auth/*` handler routes) embed the raw IP for the length of the window.

## Accepted trade-offs
- **The limiter fails closed, so the durable Redis is on the critical path for signup, login and
  invite-accept.** `skipOnError` is `false` (and Better Auth's limiter behaves the same way): if
  the durable Redis is unreachable or full, those routes error instead of going unthrottled. An
  outage of that instance therefore also stops people signing up, logging in and accepting
  invites, on top of the collector and worker impact HLD Q2/Q14 already accept. We prefer that to
  an open brute-force window. Already-issued sessions keep working (session checks don't touch
  the limiter).
- **The per-email limits allow targeted lockout.** Anyone who knows an address can send 5 bad
  logins a minute (or 20 an hour) and keep the real owner from logging in. The counter is keyed on
  the email, not on the credentials' correctness, so we can't tell the owner from an attacker. We
  accept this: the lockout lasts only as long as the attacker keeps sending, it doesn't disable the
  account, and the alternative, no per-account cap, leaves distributed guessing across many IPs
  unbounded. Revisit if it is abused (e.g. CAPTCHA or a per-IP+email pairing).

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
