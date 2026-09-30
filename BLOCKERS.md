# Blockers

Things the M1 goal run could not finish on its own, and exactly what unblocks each. Newest first. Each is
also tracked as a GitHub issue where it is deferred code work.

## 0a. ~~No orders/create webhook subscription~~ — RESOLVED (issue #73, PR #76)
**Ticket:** M1-1/M1-2. **Issue:** [#73](https://github.com/shreyahhh/Hisaab/issues/73) (closed).

Fixed by declaring `[[webhooks.subscriptions]]` in `shopify.app.toml` (four blocks, matching
`apps/api/src/routes/shopifyWebhooks.ts`'s existing `:topic` groups) and deploying live as app version
`louis-belcher-5`. Deploying surfaced a second gap — `fulfillments/create`/`fulfillments/update` need
`read_fulfillments`, which was missing from `SHOPIFY_OAUTH_SCOPES` since v0.3 — fixed in the same PR.
**The already-connected dev store needs to reconnect** before it actually receives the two
`fulfillments/*` topics (Shopify doesn't retroactively grant a newly-added scope to an existing
token); `orders/*`, `refunds/create`, `app/uninstalled` and the compliance topics work immediately,
no reconnect needed, since `read_orders` already covered them. Re-ran the historical-order backfill
afterward and the previously-stuck order (`louis-belcher-store.myshopify.com`, confirmation
#0QUV5RFPC) landed in Postgres — confirms the bulk-operations path was always fine; only live webhook
delivery was missing, and a **new** order (not backfilled) hasn't yet been used to prove live delivery
end-to-end.

## 0b. ~~No way to confirm India opt-in~~ — RESOLVED (issue #72, PR #75)
**Ticket:** M1/onboarding wizard. **Issue:** [#72](https://github.com/shreyahhh/Hisaab/issues/72) (closed).

Fixed by `POST /v1/stores/:id/privacy/confirm-india-opt-in` (owner/admin), which sets
`stores.privacy_config.checklist.india_opt_in_confirmed_at` through the proper scoped repository layer
and republishes the collector config, same pattern as `POST /v1/orgs/:id/dpa/accept` (issue #22).
Verified live: called it for the real connected dev store (DPA already accepted) and its collector
config flipped from `inactive: consent_region_unconfirmed` to `active` immediately. **Still open:** no
dashboard onboarding step calls this yet — only the API exists.

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

## 2. ~~No real orders in the connected dev store~~ — RESOLVED via backfill (webhooks fixed in #73)
**Ticket:** M1-3 / M1-3b (Shopify backfill).

The real INR order placed live this session (confirmation #0QUV5RFPC) landed in Postgres via a re-run
of the bulk-operations backfill, after #0a's webhook-subscription fix and reconnect (see #1). Backfill
itself was proven end-to-end earlier the same session too: it correctly skipped one non-INR historical
order before the store's currency was switched to INR.

**Still open:** this order's `visitor_id` is empty and `attribution_confidence` is `low` — the
shopper's pixel events for that specific visit were never captured (the collector was still
`inactive: consent_region_unconfirmed` at the time; fixed afterward in #72, too late for this one
visit). Proving the full pixel → collector → touchpoints → identity-stitch → Journeys-page chain needs
a **new** test order placed now that both #72 and #73 are fixed — not yet done.

## 3. ~~The Web Pixel cannot be deployed or seen live from here~~ — RESOLVED (M1-9)
**Ticket:** M1-4. **Issue:** #43 (still open for the "verify in a live storefront" half — blocked on #1).

Deployed this session: `shopify app config link` (device-code login) + `shopify app deploy
--allow-updates`, after adding `@shopify/web-pixels-extension` as an approved dependency
(`apps/shopify-app/package.json`) — that package, not Partner-app scaffolding, was the actual
blocker. Released as `louis-belcher-3`. Installing it live on the dev store still needs #1 resolved
first (reconnect triggers `installWebPixel`).
