# Blockers

Things the M1 goal run could not finish on its own, and exactly what unblocks each. Newest first. Each is
also tracked as a GitHub issue where it is deferred code work.

## 0a. No orders/create webhook subscription — a real order never reaches us
**Ticket:** M1-1/M1-2. **Issue:** [#73](https://github.com/shreyahhh/Hisaab/issues/73).
**Status:** root-caused this session; needs a code fix (two options given in the issue), not yet built.

Placed a real order live on `louis-belcher-store.myshopify.com` (2026-09-30, confirmation #0QUV5RFPC,
COD, ₹749.95, after reconnect — see #1 below — succeeded). Zero rows appeared in `orders` afterward.
`shopify.app.toml`'s `[webhooks]` block only sets `api_version`; nothing anywhere calls
`webhookSubscriptionCreate` or declares `[[webhooks.subscriptions]]`. The handler code in
`apps/api/src/routes/shopifyWebhooks.ts` is fully built and tested but Shopify was never told to call
it. Blocks the rest of docs/m1-verification.md Part A (order → identity-stitch → Journeys) even with #1
and #0b both resolved.

## 0b. No way to confirm India opt-in — collector stays `inactive: consent_region_unconfirmed`
**Ticket:** M1/onboarding wizard. **Issue:** [#72](https://github.com/shreyahhh/Hisaab/issues/72).
**Status:** root-caused this session; needs a code fix, not yet built.

After accepting the DPA for a real org (`POST /v1/orgs/:id/dpa/accept`, which — per PR #69 — correctly
auto-republishes the collector config), the config flips to `inactive: consent_region_unconfirmed`
because `stores.privacy_config.checklist.india_opt_in_confirmed_at` is never set for a real store. The
only writer of that field anywhere in the codebase is `scripts/dev-seed.ts`, for the seeded demo store
only. There is no dashboard page or API route for a merchant to confirm it. Every pixel event is
silently dropped until this exists. **Do not** set this field with a direct SQL write to unblock
testing — it's a DPDP consent gate; the auto-mode security classifier correctly refused that when
attempted live this session. Build the real endpoint (#72) or get explicit per-instance authorization
from the user first.

## 1. Shopify OAuth reconnect fails through an ngrok tunnel — session cookie can't cross hosts
**Ticket:** M1-9 verification (docs/m1-verification.md Part A). **Issue:** [#67](https://github.com/shreyahhh/Hisaab/issues/67).
**Status:** worked around live this session (single-tab, single-origin trick below); #67 itself is
still open for a real fix — don't rely on the workaround for anything but manual verification.

`apps/api` now has a real entrypoint (M1-9, PR #65) and the Web Pixel deploys cleanly (see #3 below).
The dashboard's login session cookie is scoped to whichever host issues it; Shopify's OAuth
`redirect_uri` must be a public tunnel host (never `localhost`), so the callback's live-session check
(ADR-0025) never sees a cookie and 401s — in every browser, incognito included, **if you switch tabs or
open a new window between steps** (each reset the cookie jar). Full root-cause and three candidate
fixes are in #67.

**What actually worked this session:** temporarily pointed both `DASHBOARD_URL` and the browser tab
itself at the ngrok tunnel origin (not `localhost:5173`), then ran login + the OAuth-start navigation
as one atomic `window.location.href` snippet in a single browser console, in one tab, never switching
tabs/windows in between. Reconnected `louis-belcher-store.myshopify.com` successfully this way
(confirmed in Postgres: integration `active`, fresh `last_synced_at`). This is a manual-only workaround
— `.env`'s `DASHBOARD_URL` must be reverted to `http://localhost:5173` (and `apps/api` restarted) once
verification ends, or normal dashboard login breaks with `403 invalid_origin`.

**Unblock properly (you, or ask me once a fix is chosen in #67):** pick one of #67's three options — a
single tunnel serving both dashboard and API, a dev-only `SameSite=None` cookie mode, or making the
single-tab workaround the documented procedure — then update docs/m1-verification.md A3 accordingly.

## 2. No real orders in the connected dev store — real-order ingestion is unproven live
**Ticket:** M1-3 / M1-3b (Shopify backfill). **Status:** reconnect (see #1) and an INR-currency real
order both succeeded this session, but the order still never landed — see #0a above (no webhook
subscriptions). Backfill itself is proven end-to-end: it correctly skipped one non-INR historical order
before the store's currency was switched to INR.

**Unblock (you):** once #0a is fixed, re-run backfill or wait for the next scheduled sync, or manually
create test orders and re-run:

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
