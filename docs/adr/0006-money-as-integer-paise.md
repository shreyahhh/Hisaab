# 0006. Money as integer paise

## Status
Accepted (fixed in SPEC §6.1, §13)

## Context
Revenue, spend, refunds and ROAS inputs come from Shopify (decimal strings), Meta (decimal strings) and Google (`cost_micros` integers, `conversions_value` doubles). Float arithmetic on money creates drift and reconciliation errors.

## Decision
Store and compute all money as **integer paise** (`bigint` in Postgres, `Int64` in ClickHouse):
- **Shopify/Meta decimal strings** → paise with a string parser, with no float intermediate (shopify-integration §4.5).
- **Google `cost_micros`** → paise with BigInt and round-half-up: `(micros + 5000n) / 10000n` (google-ads §4.2).
- **Platform-reported conversion values** (doubles by nature) → `Math.round(value * 100)`.
- API responses carry integer paise; the dashboard converts to rupees only when formatting (`Intl.NumberFormat('en-IN')`).
- Aggregates of `credit × paise` are Float64 in ClickHouse and rounded once, at the response. Per-order displays use largest-remainder rounding.

## Consequences
- Exact sums and reconciliation with Shopify totals.
- Every adapter needs a tested money parser; there are no `parseFloat` paths for money (lint rule and unit tests).
- Non-INR currencies are out of MVP scope (FX conversion is Phase 2, SPEC v0.4).
