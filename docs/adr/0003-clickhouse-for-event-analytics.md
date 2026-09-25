# 0003. ClickHouse for events and analytics

## Status
Accepted (fixed in SPEC §3); hosting in Accepted ADR-0013 (ClickHouse Cloud ap-south-1, conditional)

## Context
Raw pixel events (13–25 months retention), touchpoints, identity links, daily ad spend and attribution credits are append-heavy and read by aggregation. Reports must return in p95 < 1.5 s over 90 days / 50k orders (SPEC §13). Per-tenant retention and verifiable erasure are hard requirements (SPEC §5.6–5.7).

## Decision
Use **ClickHouse** for:
- `events`, `touchpoints` (`ReplacingMergeTree`, ADR-0017);
- `identity_links`, `ad_spend_daily`, `order_status` (`ReplacingMergeTree` with version columns);
- `attribution_results` (`MergeTree`, versioned by `computed_at`).

Details are in SPEC v0.5 §6.2 and HLD §8. All access goes through the scoped query builder (ADR-0016). Deletion follows ADR-0015. Every table is `store_id`-leading in `ORDER BY`.

## Consequences
- Fast columnar aggregation; query-time revenue (credit × current order status) avoids re-running attribution when a delivery status changes.
- `ReplacingMergeTree` is eventually consistent, so reads use `FINAL`/`argMax` where exactness matters (HLD §8).
- Row deletes are lightweight deletes with forced merges for physical purge ≤ 7 days (ADR-0015).
- A second datastore to operate, back up and secure alongside Postgres; single node for MVP (HLD §7, §11).
