# 0025. Shopify OAuth `state`: an HMAC-signed, single-use token backed by a durable-Redis nonce

## Status
Accepted (2026-09-27)

## Context
`lld/shopify-integration.md` §2.1 specifies the OAuth `state` parameter as "a signed JWT (`orgId`, `userId`,
`storeId?`, `nonce`, `exp` = 10 min)". No JWT library (`jsonwebtoken`, `jose`) is listed in SPEC §3 or
installed anywhere in the repo, and CLAUDE.md rule 7 requires asking before adding a dependency not in that
list. Signature verification alone (a signed-but-replayable token) is also not enough on its own: without a
nonce that is consumed exactly once, a captured `state` value — e.g. from a referrer leak, a shared
terminal, or a browser history sync — could be replayed to complete a second OAuth callback for the same
org/user before it naturally expires.

## Decision
- `state` is a self-issued token, not a JWT: `base64url(JSON payload) + '.' + base64url(HMAC-SHA256(payload))`,
  built with `node:crypto` and a dedicated signing secret (env, no default, on the log-redaction list).
  Payload: `{ userId, organizationId, shop, nonce, exp }` (`exp` = issue time + 10 minutes, per the LLD).
- **The nonce is the single-use control, not the signature.** At issue time (`GET .../connect`), the
  nonce is written to durable Redis as `oauth:shopify:state:<nonce>` → `{ userId, organizationId, shop }`,
  `EX 600` (10 minutes, matching `exp`). At the callback, after the signature and `exp` check pass, the
  handler does an atomic `GET`-then-`DEL` (Lua/`GETDEL`) on that key: a missing key (already used, or
  expired and evicted) fails the callback the same way a bad signature does. This makes the token
  literally single-use regardless of clock skew between signing and Redis's own TTL eviction.
- The callback additionally requires a **live session** and rejects with the same generic error whenever:
  the signed-in session's user id differs from the token's `userId`; the `shop` query param differs from
  the token's `shop`; the nonce is missing/expired/already consumed; or the caller's current role no longer
  has `integrations.manage` (re-checked at callback time, in case role changed between connect and
  callback). Each rejection path is tested individually.
- New canonical Redis key (durable instance, HLD §8): `oauth:shopify:state:<nonce>` — global, not
  `store_id`-prefixed (there is no store yet at connect time), a fourth documented exception alongside the
  three HLD §8 already lists (`collector:store:<store_key>`, `suppress:ready`, `stream:events-raw`/
  `stream:events-dead`). The value carries `userId`/`organizationId`/`shop`, never a store id or any
  shopper identifier.
- No new dependency: `node:crypto` for HMAC, the durable-Redis `ioredis` client already wired into
  `apps/api` (reused from `rateLimit.ts`'s connection) for the nonce.

## Consequences
- Functionally equivalent to a JWT for this use (short-lived, server-issued-and-verified only, no need for
  JWT's cross-service interop) without a new dependency.
- The nonce store is a hard dependency on durable Redis being reachable at both connect and callback time;
  an outage between the two makes the flow fail closed (a legitimate retry from onboarding is expected and
  cheap — the merchant just clicks connect again).
- `docs/architecture/lld/shopify-integration.md` §2.1 is updated to describe this mechanism instead of a
  signed JWT.
