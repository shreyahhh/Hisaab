# Blockers

Things the M1 goal run could not finish on its own, and exactly what unblocks each. Newest first. Each is
also tracked as a GitHub issue where it is deferred code work.

## 1. Shopify OAuth reconnect fails through an ngrok tunnel — session cookie can't cross hosts
**Ticket:** M1-9 verification (docs/m1-verification.md Part A). **Issue:** [#67](https://github.com/shreyahhh/Hisaab/issues/67).
**Status:** root-caused this session; needs a design decision, not a quick patch.

`apps/api` now has a real entrypoint (M1-9, PR #65) and the Web Pixel deploys cleanly (see #2 below),
so this is now the only thing blocking Part A end to end. The dashboard's login session cookie is
scoped to whichever host issues it; Shopify's OAuth `redirect_uri` must be a public tunnel host
(never `localhost`), so the callback's live-session check (ADR-0025) never sees a cookie and 401s —
in every browser, incognito included. Pointing the dashboard's own API calls at the tunnel instead
just breaks the rest of the dashboard (`SameSite=Lax` cookies are excluded from cross-site `fetch`).
Full root-cause and three candidate fixes are in #67.

**Unblock (you, or ask me once a fix is chosen in #67):** pick one of #67's three options — a single
tunnel serving both dashboard and API, a dev-only `SameSite=None` cookie mode, or a documented
single-tab manual workaround — then redo docs/m1-verification.md A3.

**Side effect:** the dev store's own Shopify token (`louis-belcher-store.myshopify.com`, org owned by
shreyyaaa369@gmail.com) is currently `ACCESS_DENIED` (checked via `dev:backfill status` this
session) and needs this reconnect to work again before backfill/webhooks can be retried.

## 2. No real orders in the connected dev store — real-order ingestion is unproven live
**Ticket:** M1-3 / M1-3b (Shopify backfill). **Status:** pipeline verified, live data missing; now
additionally blocked on #1 above (the store's token needs reconnecting before another backfill can run).

The backfill ran end to end against `louis-belcher-store.myshopify.com` twice (start → Shopify bulk
operation → `bulk_result` → `settings.backfill.status = done`). Both times Shopify's own
`rootObjectCount` was **0**, and we applied 0, so there is nothing to ingest: the store has no orders
created in the last 60 days that this app's token can see. The mapping/apply path is covered by worker
tests (real Postgres, faked adapter) and adapter tests (real HTTP shapes), but not by a live order.

**Unblock (you):** once #1 is resolved and the store is reconnected, create one or two test orders in
the dev store (Admin → Orders → Create order, mark as paid or as a COD/manual payment), then:

```sh
pnpm --filter @truepath/workers dev            # the consumer, if not already running
pnpm --filter @truepath/workers dev:backfill start  ea9ceaee-fd4c-47f9-a555-532cf8a4a953 60
pnpm --filter @truepath/workers dev:backfill status ea9ceaee-fd4c-47f9-a555-532cf8a4a953   # wait for a bulk_operation_id
pnpm --filter @truepath/workers dev:backfill apply  ea9ceaee-fd4c-47f9-a555-532cf8a4a953
```

`status` should then show `orders_applied` = `orders_reported` = the number of orders you created, and
`select external_order_id, total_amount_paise, payment_method from orders` in Postgres will show them.
Live `orders/create` webhooks additionally need a public URL for the API (a tunnel) — see #1.

## 3. ~~The Web Pixel cannot be deployed or seen live from here~~ — RESOLVED (M1-9)
**Ticket:** M1-4. **Issue:** #43 (still open for the "verify in a live storefront" half — blocked on #1).

Deployed this session: `shopify app config link` (device-code login) + `shopify app deploy
--allow-updates`, after adding `@shopify/web-pixels-extension` as an approved dependency
(`apps/shopify-app/package.json`) — that package, not Partner-app scaffolding, was the actual
blocker. Released as `louis-belcher-3`. Installing it live on the dev store still needs #1 resolved
first (reconnect triggers `installWebPixel`).
