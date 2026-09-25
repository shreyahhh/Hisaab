# 0008. Shopify Web Pixel extension for first-party tracking

## Status
Accepted (fixed in SPEC §2 S3, §7.1)

## Context
Tracking must be consent-gated (P-1), work on Shopify storefront and checkout, and survive Shopify's restrictions on scripts in checkout.

## Decision
Use an **app Web Pixel extension**:
- `runtime_context = "strict"`, with `customer_privacy`: `analytics = true`, `marketing = false`, `preferences = false`, `sale_of_data = "enabled"`. Shopify loads the pixel only with analytics consent; marketing is read per event ([pixel privacy](https://shopify.dev/docs/api/web-pixels-api/pixel-privacy)).
- It subscribes to the standard events in SPEC §7.1 plus `visitorConsentCollected`.
- **Late consent**: callbacks run only after consent, and earlier events are then replayed ([pixels — requesting consent](https://shopify.dev/docs/apps/build/marketing/pixels)), so landing UTMs survive.
- Transport: `fetch` with `keepalive` (`sendBeacon` is deprecated) to `POST /v1/collect`, with a text/plain body and the signature in the query string.
- `visitor_id` and `_fbp`/`_fbc` are read and written via `browser.cookie` / `browser.localStorage` on the shop's domain.
- Contact fields come from checkout events and need protected-customer-data Level 2.

## Consequences
- Consent enforcement is native to Shopify; the Collector re-checks it.
- The sandbox sends `Origin: null`, so the Collector relies on the signature, a page-host check and rate limits rather than CORS origins (collector §4).
- `checkout_completed` may not fire if the Thank-you page fails to load, which is why identity stitching has fallbacks.
- Third-party checkouts are not covered (out of scope, SPEC §2).
- Dev-store tests are still needed for replay details, withdrawal delivery, `keepalive` and the order-id format.
