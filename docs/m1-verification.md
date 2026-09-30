# M1 live verification checklist

A step-by-step guide for checking M1 (pixel → Collector → event pipeline → identity stitching, plus the
Meta warm-up slice) against a real Shopify development store and a real Meta ad account. Every automated
test in the repo runs against fixtures; nothing so far has touched a real Shopify store or a real Meta
API response. This is that check.

No code changes are needed to follow this document — it's commands to run and places to look.

---

## 0. Before you start — read this first

**Update (M1-9, PR #65): `apps/api` now has a real entrypoint** — `.listen()` is wired, and
`pnpm --filter @truepath/api build && node dist/index.js` (or `pnpm --filter @truepath/api dev`)
actually binds `API_PORT`. Issue #2 is closed; #3/#6/#8 are still open but don't block this checklist.

**Current, real blocker for Part A: [issue #67](https://github.com/shreyahhh/Hisaab/issues/67) —
the session cookie can't cross the `localhost` (dashboard) <-> ngrok tunnel (Shopify's required
public callback host) boundary.** Concretely, once you point `SHOPIFY_APP_URL` at an ngrok tunnel so
Shopify has a public `redirect_uri` to call back to:
- Logging into the dashboard at `http://localhost:5173` gets you a session cookie scoped to
  whichever host issued it (`localhost`, if `VITE_API_URL` stays `http://localhost:3000`).
- The OAuth callback (`GET /v1/integrations/shopify/callback`) must land on the tunnel's host
  (Shopify's `redirect_uri` can never be `localhost`) and does its own live-session check
  (ADR-0025) — but the `localhost`-scoped cookie is never sent to a different host, so it 401s
  with `{"error":"unauthenticated"}`, in every browser, incognito included.
- Pointing the dashboard's own `VITE_API_URL` at the tunnel instead just trades this for a
  different failure: the dashboard page still loads from `localhost:5173`, so its `fetch()` calls to
  the tunnel become cross-site requests, and `SameSite=Lax` session cookies are excluded from
  cross-site `fetch`/XHR entirely (only top-level navigations are exempt) — so `/v1/me`, `/v1/orgs`,
  etc. all 401 instead, breaking the rest of the dashboard.
- ngrok's free-tier browser-warning interstitial adds a second wrinkle: it intercepts real-browser
  requests (not `curl`, which is why testing the exact same flow with `curl` passes while a real
  browser fails) — `apps/dashboard/src/api.ts` sends `ngrok-skip-browser-warning` on its own
  `fetch()` calls to work around this, but a raw top-level navigation (the `/connect` link itself)
  still shows the interstitial once per browser session and needs a manual "Visit Site" click.

See #67 for the three candidate fixes (none implemented yet — it needs a decision, since two of them
touch auth-tenancy.md's cookie/session config). Until it's resolved, Part A cannot be completed via a
tunnel. The Web Pixel deployment step (A5) does **not** depend on this — it went through cleanly via
`shopify app deploy` once `@shopify/web-pixels-extension` was added as an approved dependency.

**Part B (Meta) is not blocked.** `apps/workers` has a real, running processor for the warm-up slice
today — you can do all of Part B right now.

### What you need before either part

- Docker Compose running: `docker compose up -d` (Postgres on `5432`, ClickHouse on `8123`/`9000`, two
  Redis instances on `6379` durable / `6380` cache).
- A local `.env` (copy `.env.example`), plus, for anything beyond the database containers:
  - `IDENTITY_KEY_READ=k1`, `IDENTITY_KEY_WRITE=k1`, `IDENTITY_MASTER_K1=<output of pnpm -s gen:identity-key>`
  - `CREDENTIALS_KEY_READ=k1`, `CREDENTIALS_KEY_WRITE=k1`, `CREDENTIALS_MASTER_K1=<32 random bytes, base64>`
  - `DPA_VERSION=v1` (or any 1–32 char value matching `[A-Za-z0-9._-]`)
  - For Part A only: `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_APP_URL` (your public tunnel
    URL), `SHOPIFY_OAUTH_STATE_SECRET` (32+ random characters) — from the Shopify Partner app you create
    in step 1.
- `pnpm install`, then `pnpm db:migrate` (Postgres + ClickHouse migrations).

### Reading the databases directly

You don't need `psql`/`clickhouse-client`/`redis-cli` installed locally — run them inside the containers:

```sh
docker compose exec postgres psql -U truepath -d truepath
docker compose exec clickhouse clickhouse-client --user truepath --password truepath --database truepath
docker compose exec redis-durable redis-cli
```

---

## Part A — Shopify (blocked until `apps/api` is running — see §0)

### A1. Create the Shopify Partner app and a development store

1. In the [Shopify Partner dashboard](https://partners.shopify.com), create an app (if you haven't
   already for M0-7). Note its **Client ID** and **Client secret** — these become `SHOPIFY_CLIENT_ID` /
   `SHOPIFY_CLIENT_SECRET`.
2. Set the app's redirect URL to `<your tunnel URL>/v1/integrations/shopify/callback` (ADR-0024: this is
   the one fixed callback path — `apps/api/src/routes/integrations.ts`).
3. Under **Apps → App settings → Customer data**, request **Protected customer data (Level 2)** access
   for email, phone and address, and check **"I have a dev store"** if offered — production access needs
   this granted, but a **development store** works without waiting for approval (SPEC M0-7 note).
4. Create a **development store** (Partner dashboard → Stores → Add store → Development store). Pick "Create a store to test and build" and add some sample products via **Shopify's own "Add sample data"** option, or add 2–3 products by hand — you'll need at least one to check out with.
5. Under the store's **Settings → Customers and consent**, confirm the cookie/consent banner setting.
   For this checklist you want **India treated as opt-in** (consent required) — SPEC P-1's default-on
   concern. If the store's banner has no explicit India rule, the runtime is "default-on" for India,
   which is exactly the unconfirmed state our onboarding gate is designed to catch (see A8 below) — so
   either configuring it correctly, or deliberately leaving it default-on, both give you something to
   verify.

**What "worked" looks like:** you have a `*.myshopify.com` admin URL you can log into, a Partner app with
a Client ID/secret, and at least one product in the store.

### A2. Start the services

In separate terminals (or `pnpm dev`):

```sh
pnpm --filter @truepath/collector dev     # listens on :3001
pnpm --filter @truepath/workers dev       # event-workers, identity-stitch, meta-warmup, suppression rebuild
pnpm --filter @truepath/api dev           # listens on :3000 (M1-9, PR #65)
```

Point your tunnel at the API's port (`API_PORT` in `.env`, default `3000`), and set `SHOPIFY_APP_URL` in
`.env` to that tunnel's `https://` URL before starting `apps/api`.

**What "worked" looks like:** the Collector logs `apps/collector: listening on :3001`; Workers logs
`apps/workers: event-workers consumer group and suppression rebuilder started`,
`apps/workers: identity-stitch worker listening`, and `apps/workers: meta-warmup worker listening`; a
`suppression_rebuilt` line appears within a few seconds (the sets are empty on a fresh database, which is
fine — `stores: 0, entries: 0` is a valid, healthy result). In Redis:

```
docker compose exec redis-durable redis-cli GET suppress:ready
```
should return a numeric timestamp, not `(nil)`. **If it's `(nil)`:** the rebuilder hasn't completed (or
Workers isn't running) — the Collector will reject every event with `503` until this is set, by design.

### A3. Install the app on the dev store

**Blocked by [#67](https://github.com/shreyahhh/Hisaab/issues/67) — see §0.** The steps below are
correct once that's fixed.

1. Log into the dashboard first (`http://localhost:5173/login`) so you have a session cookie, then —
   in the *same tab* — visit
   `<tunnel URL>/v1/orgs/<your org id>/integrations/shopify/connect?shop=<store>.myshopify.com`
   (the org id is in the path, not a query param — `GET /v1/orgs/:id/integrations/shopify/connect`,
   `apps/api/src/routes/integrations.ts`; you'll need an org created first, via the auth/signup flow
   or `pnpm dev:seed`).
2. Approve the OAuth prompt on Shopify's side. You should land back on the dashboard URL.

**Check in Postgres:**
```sql
select id, shop_domain, status, installed_at from stores order by installed_at desc limit 1;
select provider, status, external_account_id from integrations where store_id = '<the store id above>';
```
**What "worked" looks like:** one `stores` row, `status = 'active'`; one `integrations` row with
`provider = 'shopify'`, `status = 'active'`.
**If there's no `stores` row:** the callback didn't complete — check the API logs for the OAuth exchange
error, and confirm the redirect URL registered in the Partner dashboard matches exactly.

### A4. Accept the DPA and confirm the India opt-in

The collector config stays `inactive` (and the Collector drops everything) until **both** are done
(privacy-dpdp.md §4.10):

```sh
curl -X POST <tunnel URL>/v1/orgs/<orgId>/dpa/accept -H 'content-type: application/json' \
  -d '{"dpa_version":"v1"}'    # match your DPA_VERSION
curl -X PUT <tunnel URL>/v1/stores/<storeId>/privacy-settings -H 'content-type: application/json' \
  -d '{"retention_months":13,"child_directed":false,"notice_version":"v1","grievance_contact":{"name":"Test","email":"test@example.com"},"checklist":{"notice_published_at":null,"banner_live_confirmed_at":null,"india_opt_in_confirmed_at":"2026-09-29T00:00:00.000Z"}}'
```

**Check in Redis:**
```
docker compose exec redis-durable redis-cli GET "collector:store:<the pixel's store_key>"
```
(You'll get the `store_key` from the pixel install in A5, or from `integrations.settings->>'store_key'`
in Postgres.) **What "worked" looks like:** a JSON blob with `"status":"active"`,
`"inactiveReason":null`. **If `status` is `"inactive"`:** the `inactiveReason` field tells you which gate
is missing (`dpa_missing` or `consent_region_unconfirmed`) — redo that step.

### A5. Deploy and install the pixel

**Update (M1-9):** the Web Pixel extension has been deployed — `shopify app config link
--client-id=<id> --force --file-name=shopify.app.toml` (once logged in via the CLI's device-code
flow), then `shopify app deploy --allow-updates`, released as `louis-belcher-3`. This needed
`@shopify/web-pixels-extension` added as a dependency (`apps/shopify-app/package.json`) — issue
**#43**'s actual blocker, not issue **#30** (the app was already scaffolded enough for `config link`
to work directly). `apps/shopify-app/shopify.app.toml`'s `application_url`/`redirect_urls` are
whatever tunnel was active at deploy time — re-run `shopify app deploy` after changing tunnels.

1. Reconnecting the store (A3, currently blocked by #67) triggers `installWebPixel`, which calls
   Shopify's `webPixelCreate`.

**Check in Postgres:**
```sql
select settings->>'pixel_status', settings->>'pixel_id', settings->>'store_key' from integrations
  where store_id = '<storeId>' and provider = 'shopify';
```
**What "worked" looks like:** `pixel_status = 'installed'`, a `pixel_id`, and a `store_key` matching
`pk_` + 24 characters. **If `pixel_status = 'not_configured'`:** `COLLECTOR_PUBLIC_URL` isn't set (issue
**#45**) — the API doesn't know the Collector's public URL to hand to the pixel. **If `'failed'`:**
`settings->>'pixel_error_codes'` names Shopify's rejection reason (commonly `NO_EXTENSION` if the
extension isn't deployed to this app yet).

### A6. Place a test order **with** consent

1. Visit the storefront in an incognito window (so you get a fresh visitor).
2. Accept analytics + marketing consent on the banner.
3. Browse a couple of products (so `page_viewed`/`product_viewed` fire), add one to cart, and complete
   checkout with a **real-shaped but fake** Indian phone number (e.g. `+919812345670`) — not a dummy
   pattern like `9999999999` or `1234567890`, which the platform blocklist strips before hashing (you
   want to see a real hash, not a null one).

**Check in ClickHouse** (events land within ~5 seconds of the pixel sending, per SPEC's freshness target):
```sql
select event_name, visitor_id, session_id, occurred_at, consent_purposes
from events where store_id = '<storeId>' order by occurred_at desc limit 20;
```
**What "worked" looks like:** a row per event you triggered (`page_viewed`, `product_viewed`,
`product_added_to_cart`, `checkout_started`, `checkout_contact_info_submitted`, `checkout_completed`,
plus a `consent_granted`), all sharing one `visitor_id`, `consent_purposes` containing
`attribution_analytics` (and `ad_platform_measurement` if you accepted marketing too).

```sql
select visitor_id, channel, campaign_id from touchpoints where store_id = '<storeId>' order by occurred_at desc limit 5;
```
**What "worked" looks like:** one touchpoint row for the session (channel `direct` unless you added UTM
parameters to the first URL you visited — try `?utm_source=facebook&utm_medium=paid_social&utm_campaign=999&utm_content=998&utm_term=997` on your first page load to see `channel = 'meta_ads'`, `campaign_id = '999'`).

**Check in Postgres**, once the order webhook has landed:
```sql
select id, external_order_id, visitor_id, phone_hash_hmac, attribution_confidence
from orders where store_id = '<storeId>' order by created_at_platform desc limit 1;
```
**What "worked" looks like:** `visitor_id` matches the ClickHouse visitor id (the order was stitched via
`order_id`), `phone_hash_hmac` starts with `k1:` (not null, not the raw number), and
`attribution_confidence = 'high'` within a few seconds (identity-stitch runs on webhook receipt). **If
`visitor_id` is null and `attribution_confidence` stays null for more than ~35 minutes:** the stitcher
never matched — check the `identity-stitch` queue's `identity-stitch-failed` dead-letter list in Redis, or
that the `checkout_completed` event actually fired (Shopify sometimes drops it if the thank-you page
navigates away too fast).

### A7. Place a test order **without** consent

1. A fresh incognito window, **decline** the consent banner (or don't interact with it, if the store is
   configured opt-out-required so nothing is pre-granted).
2. Browse and complete a checkout the same way.

**Check in ClickHouse:**
```sql
select count(*) from events where store_id = '<storeId>' and visitor_id = '<this visitor's id>';
```
You won't have this visitor's id from the UI easily — instead check the Collector's own counters:
```
docker compose exec redis-durable redis-cli HGETALL "stats:collector:<storeId>:<yyyymmdd IST>"
```
**What "worked" looks like:** a `no_analytics_consent` field with a count ≥ 1, and **zero** ClickHouse
rows for that visitor. This is SPEC §5.10 compliance test 1, run live: an event without consent is
dropped at the Collector, counted, and nothing is stored. The order itself still lands in Postgres (via
the webhook, independent of the pixel) — that's correct; only the pixel's tracking is consent-gated, not
the merchant's own order data.

### A8. The default-on consent signal (optional, informational)

Not enforced yet (deferred, issue **#52**) — but you can still see the raw counters:
```
docker compose exec redis-durable redis-cli HGETALL "stats:collector:<storeId>:<yyyymmdd IST>"
```
`new_visitors` and `new_visitors_initial_only` tell you, per SPEC v0.6's default-on detection design, how
many new visitors had analytics "allowed" with no `interaction`-triggered consent event — i.e. whether
your store's banner is really opt-in for India or silently default-on. A high
`new_visitors_initial_only / new_visitors` ratio here means the banner isn't actually gating anything for
Indian visitors, regardless of what the settings screen says.

### A9. The late-consent replay test

This is the one item flagged **unverified** in `event-pipeline.md §4.2` since M1-6: Shopify's pixel
manager, in a default-on region, runs pixel callbacks immediately and — per
[Shopify's own docs](https://shopify.dev/docs/apps/build/marketing/pixels) — **replays previously
registered events** once a consent-gated pixel is allowed to load. Our sessioniser assumes that when this
replay happens, the replayed landing event's `occurred_at` is *earlier* than the consent event's, so
sorting by `occurred_at` puts the landing page first and it becomes the session start (carrying the
UTMs). This test checks whether that assumption holds against real Shopify behaviour.

1. Use a store configured **default-on** for India (or temporarily switch the banner setting) so
   analytics is allowed without an explicit accept.
2. In a fresh incognito window, load a product page with UTM parameters in the URL, e.g.
   `https://<store>.myshopify.com/products/<handle>?utm_source=facebook&utm_medium=paid_social&utm_campaign=555`.
3. Wait 10–15 seconds (so a `page_viewed` has a chance to fire under the default-on signal), then interact
   with the consent banner if one appears, or simply wait — the point is to capture whatever Shopify
   actually sends, not to force a particular UI path.
4. Browse to one more product page (no UTM this time) so you have a second, later event to compare
   against.

**Check in ClickHouse:**
```sql
select event_name, occurred_at, received_at, utm_source, utm_campaign, session_id
from events where store_id = '<storeId>' and visitor_id = '<this visitor>'
order by received_at asc;   -- arrival order, NOT occurred_at — this is the point of the test
```
**What you're checking:**
- Compare `occurred_at` (when the pixel says the event happened) against `received_at` (when our
  Collector actually got it). If the first `page_viewed`'s `occurred_at` is noticeably **earlier** than
  its `received_at` (more than a second or two), and a `consent_granted` event arrived at nearly the same
  `received_at` but with a **later** `occurred_at` than the page view — that's the replay pattern the LLD
  describes, and it confirms our assumption.
- If instead every event's `occurred_at` and `received_at` are close together, in the same order, with no
  gap — Shopify **isn't** replaying in this configuration, and the "landing attribution survives late
  consent" claim doesn't need defending because there's no late-consent case to survive.
- Either way, check the resulting touchpoint:
  ```sql
  select channel, campaign_id from touchpoints where store_id='<storeId>' and visitor_id='<this visitor>';
  ```
  **What "worked" looks like:** `channel = 'meta_ads'`, `campaign_id = '555'` — i.e. the UTM-bearing page
  view is what started the session, regardless of consent timing. **If you instead see `channel =
  'direct'`** or a campaign id from neither page: the second (non-UTM) page view became the session start
  instead, meaning the out-of-order edge case `event-pipeline.md §4.2` calls "the accepted imprecision of
  running more than one consumer" showed up even with one consumer — worth a closer look, and a real
  finding for this test.

### A10. Which `checkout.order.id` format Shopify sends

`identity-stitching.md §4.1` step 2 flags this as unconfirmed: does Shopify's pixel `checkout_completed`
event give `checkout.order.id` as a GID (`gid://shopify/Order/5001`) or a plain number (`"5001"`)? Our
code (`normaliseOrderId`, `packages/shared`) accepts either, but nobody has seen the real value.

**Check in ClickHouse**, using the order you placed in A6:
```sql
select properties from events where store_id='<storeId>' and event_name='checkout_completed'
  order by occurred_at desc limit 1;
```
`properties` is a JSON string; look at its `order_id` field.
**What you're checking:** if it's a bare number like `"5001"`, Shopify sends plain numeric ids. If it
starts with `gid://shopify/`, it sends GIDs. **Either result is fine** — both are handled — this is purely
about recording which one actually happens, so the comment in the code can stop saying "unconfirmed."

Then confirm the two sides actually matched:
```sql
select external_order_id, visitor_id from orders where store_id='<storeId>' order by created_at_platform desc limit 1;
```
**What "worked" looks like:** `orders.visitor_id` is set (non-null) — meaning `normaliseOrderId` on
whatever format the pixel sent produced the same numeric string as `orders.external_order_id` (which
always comes from the webhook, always numeric), so the `checkout:` key matched and the stitcher linked
them. If `visitor_id` is null here but was set in A6 by a *different* path (the `order_id` primary match
rather than the `checkout:` key), that's still a pass for A6 but doesn't tell you anything about the
format — repeat with a fresh order where the pixel event is likely to arrive first.

---

## Part B — Meta (not blocked — runnable today)

### B1. Create a test ad account and a long-lived token

1. In [Meta Business Manager](https://business.facebook.com), use (or create) a test ad account. Note its
   id in the form `act_<digits>`.
2. Generate a **Business Integration System User** access token with `ads_read` (Business Settings →
   Users → System Users → Add → assign the ad account → Generate token). This is the long-lived token
   type `meta-integration.md §2.3` expects for `meta-warmup` — it doesn't expire on the usual 60-day
   schedule.

### B2. Register the account and start the warm-up job

```sh
pnpm --filter @truepath/workers dev:meta-warmup register <storeId> act_<accountId> "<a name>" INR Asia/Kolkata
# paste the access token when prompted, then press Enter
pnpm --filter @truepath/workers dev:meta-warmup start <storeId>
```
(`<storeId>` needs to already exist as a `stores` row — from Part A if it's available, or ask me to add a
minimal seed path for Meta-only testing if you want to verify this without a Shopify store at all.)

**Check in Postgres:**
```sql
select provider, status, settings from integrations where store_id='<storeId>' and provider='meta';
select external_id, name, currency, timezone from ad_accounts where store_id='<storeId>' and provider='meta';
```
**What "worked" looks like:** one `integrations` row, `status='active'`, `settings->>'ad_account_ids'`
containing your `act_...` id; one `ad_accounts` row with the name/currency/timezone you gave it.

### B3. Run one warm-up pull and check the result

```sh
pnpm --filter @truepath/workers dev:meta-warmup run <storeId>
```
Watch the Workers process's stdout for a `meta_warmup_run` JSON line (within a few seconds).

**What "worked" looks like:** `calls_success: 1` (or however many accounts you registered),
`calls_error: 0`. **If `calls_error: 1`:** the same log line's neighbouring `meta_warmup_account_failed`
line names an `error_name` (never the message or the token) — that's your starting point.

**Check the ledger in Postgres:**
```sql
select settings->'warmup' from integrations where store_id='<storeId>' and provider='meta';
```
**What "worked" looks like:** `{"calls_total": 1, "calls_success": 1, "calls_error": 0, "last_run_at": "..."}`.

**Check `ad_spend_daily` in ClickHouse** (only populated if your test account has any spend/activity in
the last 2 days — a brand-new test account with no campaigns will legitimately return zero rows, which is
still a successful call):
```sql
select date, account_id, campaign_id, spend_paise, platform_conversions, attribution_window
from ad_spend_daily where store_id='<storeId>' order by synced_at desc limit 20;
```

### B4. Confirm `action_attribution_windows`

`meta-integration.md §2.3` requests `["7d_click","1d_view"]` — the two windows still supported after
Meta's 2026 removal of the 28-day windows. This is baked into the adapter's request URL, not something to
configure, so the check is: does Meta actually return data for those windows, or reject/ignore them?

1. Capture the raw request. Easiest way: temporarily set a breakpoint or add a `console.log(url)` in
   `packages/integrations/src/meta/adapter.ts`'s `insightsUrl` — or, without touching code, watch your
   network egress with a proxy (e.g. `mitmproxy`) while running B3, and find the
   `graph.facebook.com/v25.0/act_.../insights` request.
2. Look at its `action_attribution_windows` query parameter — it should be the JSON array
   `["7d_click","1d_view"]`, URL-encoded.
3. In the response body (same proxy capture, or Meta's own [Graph API Explorer](https://developers.facebook.com/tools/explorer/) making the identical call by hand), check that each `actions`/`action_values` entry has `7d_click` and `1d_view` keys, not an error about unsupported windows.

**What "worked" looks like:** the response has data, with `7d_click`/`1d_view` keys present on action
entries that have any activity. **If Meta returns an error mentioning attribution windows:** the windows
this codebase requests may have changed again since this was written (2026-09) — check
[Meta's Insights docs](https://developers.facebook.com/docs/marketing-api/insights/) for the current
supported list and let me know; that's a one-line adapter change, not a design issue.

### B5. Confirm the purchase action type

`meta-integration.md §4.2` and `packages/integrations/src/meta/mapper.ts` try `omni_purchase` first,
falling back to `offsite_conversion.fb_pixel_purchase` — marked **VERIFY** against a real Shopify-channel
pixel, because Meta's own "Purchases" column in Ads Manager might map to a different `action_type`.

1. In the same captured response from B4 (or a fresh Graph API Explorer call against a campaign that has
   actual purchases — your test account likely won't unless you're using a partner's real account with
   its consent), find the `actions` array entries and note every `action_type` value present.
2. In Meta Ads Manager, look at the same campaign/ad's **Purchases** column for the same date range.

**What "worked" looks like:** the `action_type` whose `7d_click`+`1d_view` sum matches (or closely tracks)
Ads Manager's displayed "Purchases" number is either `omni_purchase` or
`offsite_conversion.fb_pixel_purchase`. **Record which one** — if it's the fallback
(`offsite_conversion.fb_pixel_purchase`) rather than `omni_purchase`, or a third type entirely, that's a
one-line change to `PURCHASE_ACTION_TYPES`'s order (or a new entry) in `mapper.ts`, worth flagging back to
me rather than fixing by hand, since it also needs a doc update in the LLD.

### B6. Rate-limit behaviour

`meta-integration.md §2.3` / `packages/integrations/src/meta/rateLimit.ts` implement: pause 60s between
pages once any `x-business-use-case-usage` metric reaches 75; back off by
`estimated_time_to_regain_access` minutes if Meta has already throttled the account; retry a 17/613/80000/80004 error with exponential backoff (30s→16min over 6 tries). A single warm-up account, pulled once every
15 minutes, is very unlikely to hit any of this in normal operation — the check here is about confirming
the *shape* of Meta's real response, not manufacturing a real rate-limit event (don't try to force one;
it risks your account's standing).

1. In the same proxy capture from B4, look at the response **headers**, specifically
   `x-business-use-case-usage`. Confirm it's present and its JSON shape matches what
   `parseBusinessUseCaseUsage` expects: `{"<act_id>": [{"call_count": N, "total_cputime": N,
   "total_time": N, "estimated_time_to_regain_access": N}]}`.
2. Note the actual numbers for a single call — they should be small (low single digits) for one call
   against a fresh test account.

**What "worked" looks like:** the header exists and parses into the shape above — meaning
`decideRateLimit`'s logic has real data to act on, even though you won't observe it *triggering* under
normal warm-up traffic. **If the header is absent or a different shape:** `parseBusinessUseCaseUsage`
already returns `[]` for anything unparseable (fails safe — no crash, just no rate-limit awareness that
run), but it's worth telling me the actual shape so the parser can be corrected rather than silently
degraded.
