# LLD — Google Ads integration

> Names are defined in [HLD §8](../HLD.md#8-cross-cutting-concepts). Pinned to Google Ads API **v25**, the latest version listed in the field reference and used in current request examples ([call structure](https://developers.google.com/google-ads/api/docs/concepts/call-structure)). **Version policy (SPEC v0.5, resolves the sunset-date VERIFY):**
- The API version is **one config constant** in `packages/integrations/google-ads` (`GOOGLE_ADS_API_VERSION = 'v25'`), next to a `GOOGLE_ADS_API_SUNSET = '<date from Google's schedule>'` constant.
- A **CI check fails when `today ≥ sunset − 60 days`**.
- Upgrades are planned **about twice a year**, following Google's [deprecation and sunset schedule](https://developers.google.com/google-ads/api/docs/sunset-dates).
- Each upgrade is a PR changing both constants and re-recording the msw fixtures.

## 1. Purpose & scope

Read-only ingestion of Google Ads spend and platform-reported conversions into `ad_spend_daily` (`platform='google'`):
- OAuth connection and account selection (including accounts under a merchant's manager account);
- GAQL reporting at `ad_group_ad` level, plus a campaign-level query for **Performance Max**;
- micros → paise conversion; health checks.

**Non-goals**
- Enhanced Conversions or any sendback to Google (out of scope, SPEC §2).
- Campaign management or writes of any kind.
- Asset-group or asset-level reporting for PMax (campaign level only in MVP).
- GA4.

## 2. Interfaces

### 2.1 Endpoints (SPEC §10)

| Method & path | Purpose |
|---|---|
| `GET /v1/integrations/google_ads/connect?storeId=` | `302` to Google OAuth with scope `https://www.googleapis.com/auth/adwords` (SPEC §8.4), `access_type=offline`, `prompt=consent`, and a signed `state` |
| `GET /v1/integrations/google_ads/callback` | Exchange for access + refresh tokens → `ListAccessibleCustomers` → account picker |
| `PUT /v1/integrations/:id/settings` | `GoogleAdsSettingsPatch { customer_ids: string[] (10 digits, no hyphens, 1–10), login_customer_id?: string }`. Audit `integration_settings_changed`. |

### 2.2 Queue job
`AdSyncGoogleAdsJob{storeId}` on `ad-sync-google-ads`. As with Meta, the range comes from the repeatable-job name:

| Name | Schedule | Range (account timezone) |
|---|---|---|
| `google-daily` | 06:30 IST | yesterday − 14 days … yesterday (conversions are restated as they come in) |
| `google-intraday` | every 3 h, 09:00–24:00 IST | yesterday … today (SPEC §13 "ad spend < 3 h"; Open question 1) |
| `google-backfill` | once on account selection | 90 days, in 30-day chunks |

`jobId = gads:<storeId>:<name>:<yyyymmddhh>`.

### 2.3 API calls (adapter `packages/integrations/google-ads`, REST over `fetch` — no new dependency)
- Headers ([call structure](https://developers.google.com/google-ads/api/docs/concepts/call-structure)):
  - `Authorization: Bearer <access token>`;
  - `developer-token: <our MCC's token>` — from Secrets Manager, platform-wide, **not** per store;
  - `login-customer-id: <manager id without hyphens>` — required when access to the account goes through a manager account.
- `GET https://googleads.googleapis.com/v25/customers:listAccessibleCustomers`.
- `POST https://googleads.googleapis.com/v25/customers/<cid>/googleAds:searchStream` with a GAQL body.

**Query A — standard campaigns** (fields confirmed in the [ad_group_ad field reference](https://developers.google.com/google-ads/api/fields/v21/ad_group_ad)):
```sql
SELECT customer.currency_code, customer.time_zone,
       campaign.id, campaign.name, ad_group.id, ad_group.name,
       ad_group_ad.ad.id, ad_group_ad.ad.name,
       segments.date,
       metrics.cost_micros, metrics.impressions, metrics.clicks,
       metrics.conversions, metrics.conversions_value
FROM ad_group_ad
WHERE segments.date BETWEEN '{from}' AND '{to}'
  AND metrics.impressions > 0
```

**Query B — Performance Max.** `ad_group` and `ad_group_ad` "won't return any data for your Performance Max campaigns"; use `campaign` or `asset_group` ([PMax reporting](https://developers.google.com/google-ads/api/performance-max/reporting)).
```sql
SELECT campaign.id, campaign.name, segments.date,
       metrics.cost_micros, metrics.impressions, metrics.clicks,
       metrics.conversions, metrics.conversions_value
FROM campaign
WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX'
  AND segments.date BETWEEN '{from}' AND '{to}'
```

**Query C — completeness check** (daily only): `SELECT segments.date, metrics.cost_micros FROM customer WHERE segments.date BETWEEN …`. The account total is compared with A + B per day; a gap above 1% (e.g. campaign types with no `ad_group_ad` rows) is written as a row with `campaign_id = 'other'`, `ad_id = 'other:<date>'` and flagged on the health screen, so blended MER stays correct.

**Access levels** ([access levels](https://developers.google.com/google-ads/api/docs/api-policy/access-levels)):
- Explorer: 2,880 operations/day on production accounts;
- Basic: 15,000/day;
- Standard: unlimited.

Basic is applied for in week 1 (SPEC §8.4, M0-7). At ~(7 intraday runs × 2 queries + 3 daily queries) ≈ 17 requests per account per day, Explorer supports ~150 accounts and Basic ~850. "One `SearchStream` request counts as one API operation irrespective of the number of batches"; exceeding the cap returns `RESOURCE_EXHAUSTED` ([quotas](https://developers.google.com/google-ads/api/docs/best-practices/quotas)).

## 3. Data owned

| Item | Access | Notes |
|---|---|---|
| `integrations` (provider `google_ads`) | write | `encrypted_credentials` = `{refreshToken, accessToken, accessTokenExpiresAt}` (all secrets); `settings` (non-secret): `customer_ids`, `login_customer_id`, `last_daily_at`, `last_intraday_at`, `backfill`, `coverage_gap_days[]` |
| `ad_accounts` | write | `provider='google_ads'`, `external_id` (10-digit customer id), `name`, `currency` (`customer.currency_code`), `timezone` (`customer.time_zone`) |
| ClickHouse `ad_spend_daily` | insert | `platform='google'`; `account_id`; `campaign_id`/`campaign_name`; `adset_id` = `ad_group.id`; `ad_id` = `ad_group_ad.ad.id`, or `'pmax:<campaign_id>'` (SPEC v0.2); `attribution_window = 'google_default'` (SPEC v0.4; Google's attribution is set per conversion action, not per request) |

No new tables, keys or queues. `attribution_window` is shared with Meta (SPEC v0.4).

## 4. Processing flow

### 4.1 Connect
1. Build the OAuth URL → consent → `callback`. Exchange the code; store the refresh token encrypted. Google issues a refresh token only with `prompt=consent` on first consent.
2. `listAccessibleCustomers` → for each, `SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer`. For managers, list clients: `SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager FROM customer_client WHERE customer_client.level <= 1`.
3. The merchant selects accounts. If one is reached via a manager, store `login_customer_id`.
4. Non-INR accounts can't be selected: the same onboarding error as Meta (`422 unsupported_ad_account_currency`, [meta-integration.md §4.1](meta-integration.md#41-connect)). FX conversion is Phase 2.
5. Write `ad_accounts`, register the repeatable jobs, enqueue `google-backfill`. Audit.

### 4.2 Sync
1. Refresh the access token if it expires within 5 min, under a Postgres advisory lock (`hashtext('gads-token:' || store_id)`), the same pattern as Shopify. `invalid_grant` → `needs_reauth`.
2. For each customer id: run A and B (and C on the daily run) with `searchStream`; parse the streamed JSON batches.
3. Map each row:
   - **Money** (integer math): `spend_paise = (BigInt(cost_micros) + 5_000n) / 10_000n` — round half-up, with 1 paise = 10,000 micros (HLD §8).
   - `platform_conversion_value_paise = Math.round(conversions_value * 100)`. The value is a double, so it is platform-reported and inexact by nature; SPEC's integer-math rule applies to micros.
   - `platform_conversions = conversions` (Float64).
   - `date = segments.date`, in the **account timezone** (HLD §8).
   - Empty `ad_group_ad.ad.name` → the stored name is `''`; the dashboard shows the id.
4. One insert per customer per run (`synced_at = now()`); re-pulled days supersede earlier rows.
5. Update `settings.last_*_at`, `integrations.last_synced_at`. Record a coverage gap from C in `settings.coverage_gap_days` (last 30 days).

```mermaid
sequenceDiagram
  participant S as Scheduler (google-daily / intraday)
  participant W as ad-sync-google-ads
  participant PG as Postgres
  participant G as Google Ads API v25
  participant CH as ClickHouse ad_spend_daily
  S->>W: AdSyncGoogleAdsJob{storeId}
  W->>PG: advisory lock; refresh access token if < 5 min
  loop each customer id
    W->>G: searchStream Query A (ad_group_ad)
    W->>G: searchStream Query B (PMax campaigns)
    opt daily
      W->>G: searchStream Query C (customer totals)
    end
    W->>W: micros → paise (BigInt, half-up); pmax:<campaign_id>; gap row if > 1%
    W->>CH: INSERT rows (synced_at = now)
  end
  W->>PG: last_synced_at, coverage gaps
```

## 5. Failure modes

| Failure | Handling |
|---|---|
| `RESOURCE_EXHAUSTED` / `QuotaError` | backoff 1 min → 32 min, 6 tries; if the daily operation cap is hit, stop intraday runs for the day and alert (upgrade to Basic/Standard) |
| `AuthenticationError` / `invalid_grant` | `needs_reauth`, jobs paused |
| `AuthorizationError.USER_PERMISSION_DENIED` | usually a missing or wrong `login-customer-id` → re-resolve the hierarchy once, else `error` with a code |
| `DEVELOPER_TOKEN_NOT_APPROVED` / Explorer limits | health: "Google Ads API access pending" |
| Stream interrupted | the whole query is retried (idempotent via `ReplacingMergeTree`) |
| PMax rows missing | Query B covers them; C flags any remaining gap |

DLQ `ad-sync-google-ads-failed`. One failing customer id doesn't block the others.

## 6. Privacy touchpoints

| ID | How |
|---|---|
| Personal data | **None processed**: aggregate ad metrics only. Nothing is sent to Google (Enhanced Conversions is out of scope). |
| S-2 | Refresh and access tokens in `encrypted_credentials`; the developer token is platform-wide in Secrets Manager. |
| S-4 | Connect, settings and disconnect audited. |
| S-6 | Developer token and OAuth client secret rotation via Secrets Manager. |
| Logs | Customer ids and row counts only. |

## 7. Performance & limits

| Item | Target |
|---|---|
| Freshness | intraday every 3 h (09:00–24:00 IST) |
| Requests | ~17 per account per day; Explorer ≈ 150 accounts, Basic ≈ 850 |
| Backfill | 90 days × 10 accounts < 15 min |
| Rows | ≈ active ads × days; PMax adds one row per campaign-day |

## 8. Test plan

**Unit**
- Micros → paise: `1_234_567` → 123 (half-up from 123.4567), `5_000` → 1 (half-up), `4_999` → 0, large values without precision loss.
- PMax row mapping (`ad_id='pmax:<cid>'`, `adset_id=''`).
- Gap-row computation.
- Timezone passthrough.

**Integration** (msw-recorded)
- `listAccessibleCustomers` + manager hierarchy → the `login-customer-id` header is set.
- A searchStream multi-batch response.
- Quota error → backoff.
- `invalid_grant` → `needs_reauth`.
- Re-pull supersedes the old row (`FINAL` returns the latest).

**§5.10 compliance tests supported**: Test 4 (no PII in logs; trivially none processed) and Test 7 (rows always carry `store_id`; the query builder requires it).

## 9. Open questions
1. *(resolved: the 3-hourly intraday pull is accepted; SPEC §13 freshness wins, and SPEC v0.4 §8.4 is updated.)*
2. *(resolved: one `searchStream` = one operation.)*
3. **Conversion-action scope.** `metrics.conversions` sums every conversion action included in "Conversions". Merchants who track many actions may want "purchase" only (`segments.conversion_action_category = 'PURCHASE'`, which needs a separate query). MVP: all included conversions, labelled as such.
4. **Asset-group reporting for PMax** (a later phase).
