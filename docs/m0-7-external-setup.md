# M0-7: external setup checklist (human-only)

SPEC §12 M0-7 is a non-code ticket. Most of it means creating accounts, apps and access requests with third parties, which need a person (identity, business verification, credentials). The repo side is done: the DPA and shopper notice drafts are in [`docs/dpdp/`](dpdp/). Nothing below has been done by automation.

Never commit secrets from any of these. Client ids and secrets go to AWS Secrets Manager and reach the apps as zod-validated env vars (SPEC §0 rule 6).

## Do these first (they have wait times that block later milestones)

| # | Item | Who | Blocks | Notes |
|---|---|---|---|---|
| 1 | **Create the Meta app** (Facebook Login for Business) and start Business Verification | Founder / business admin | M1-8, M2-1 | SPEC v0.5: create the app in M0-7, not later. Advanced Access needs **at least 1,500 successful Marketing API calls in the prior 15 days with under 15% errors**, so the M1-8 warm-up slice must start early (HLD §11). Permissions to request: `ads_read`, `business_management` (as needed). |
| 2 | **Shopify Partner account and public app** | Founder | M1-1 | Scopes (SPEC §8.1 v0.3): `read_orders`, `write_pixels`, `read_customer_events`. `read_customers` and `read_products` are **not** requested. New public apps use expiring offline tokens (1 h access, 90-day refresh). Create a dev store for M1. |
| 3 | **Request protected customer data access, Level 2** (email, phone, address) | Founder | Production use of M1-2, M1-4, M4-1 | Dev stores work without approval; production stores do not. Needed for pixel checkout contact data, order webhooks, the CAPI re-fetch and the zip-to-pincode-prefix. Describe purposes exactly as in the DPA (`attribution_analytics`, `ad_platform_measurement`). |
| 4 | **Apply for `read_all_orders`** | Founder | Nothing (non-blocking) | Until granted, backfill covers 60 days; it extends to 90 automatically once granted (SPEC v0.3). |
| 5 | **Google Ads developer token, Basic access**, from our manager (MCC) account | Founder | M2-2 | Explorer access has too little production quota. Plan Standard access before scaling (SPEC §8.4). |
| 6 | **DPA and shopper notice reviewed by counsel** | Founder + counsel | Production launch; the DPA version string | Drafts: [`dpdp/dpa-template.md`](dpdp/dpa-template.md), [`dpdp/shopper-notice.md`](dpdp/shopper-notice.md). Each ends with an open-items list. |

## Details for counsel review (item 6)

The drafts collect the open legal questions in one place so counsel can answer them in one pass. All are also flagged in HLD §8 and the LLDs:
1. Company details, liability, term, governing law (DPA §11).
2. Sub-processor notice period and objection remedy (DPA §5).
3. Meta's characterisation as a recipient; Sentry EU telemetry transfer (DPA §5, §6; `subprocessors.md`).
4. Wording of the "India requires opt-in" confirmation and responsibility if wrong (DPA §4; README).
5. DPDP Act s.8(7): erasing analytics data on withdrawal of consent (notice; DPA §7).
6. Consent evidence versus erasure; the 13-month suppression list (DPA §7).
7. Rule 7 breach timelines and the 24-hour processor-to-fiduciary commitment (DPA §8).
8. Whether data collected before default-on detection must be erased (README).
9. A native Hindi review of the shopper notice.

## After counsel signs off

1. Replace the `[placeholders]` in both drafts and bump the version string.
2. Set `DPA_VERSION` (env) to the approved version for every environment. The accept endpoint (issue #7) rejects any other version with `409 dpa_version_mismatch`.
3. Publish the notice text to `notice_version` in each store's privacy settings (M4-2).

## What is deliberately not here
- No API keys, tokens or app secrets, and no step-by-step instructions for obtaining them.
