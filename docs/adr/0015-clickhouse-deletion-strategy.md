# 0015. ClickHouse deletion strategy

## Status
Accepted (batch-2 review, 2026-09-24) — the recommendation below is the decision.

## Context
SPEC §15 item 5 leaves the ClickHouse deletion mechanism open ("lightweight deletes vs mutations vs tombstones"). Three kinds of deletion hit ClickHouse, and they have different shapes:

| Kind | Shape | Volume | Latency need |
|---|---|---|---|
| **Erasure** — merchant DSR, Shopify `customers/redact`, withdrawal-triggered erasure (privacy-dpdp §4.4–§4.5), new-device follow-up | a few `visitor_id`s / `order_id`s scattered across all partitions | many small requests; withdrawals can burst | DSR SLA 7 days; withdrawal 24 h; must be *verifiable* (§5.10 test 5) |
| **Retention** — `events`/`touchpoints` older than the store's window (3–25 months), `identity_links`, and order-linked rows at 25 months (privacy-dpdp §4.8) | everything for a store older than a cutoff — the oldest partitions | large (most of the stored data turns over) | SPEC §5.7: "nightly"; §5.10 test 6 |
| **Superseded versions** — old `computed_at` runs in `attribution_results` (HLD §8) | older versions per (order, model) | moderate; grows with the nightly 45-day recompute | none — readers already ignore them |

Tables: `events` and `touchpoints` are `ReplacingMergeTree`, `PARTITION BY toYYYYMM(occurred_at)` (SPEC v0.2), with the store id leading `ORDER BY`. There is one shared table for all tenants, so a partition holds every tenant's month.

Relevant ClickHouse behaviour ([lightweight DELETE guide](https://clickhouse.com/docs/guides/developer/lightweight-delete)):
- Lightweight `DELETE FROM` writes a `_row_exists` mask; reads filter it immediately; rows are physically removed by later merges.
- `ALTER TABLE … DELETE` (a mutation) rewrites every affected part.
- `DROP PARTITION` removes whole parts at almost no cost.

## Options

**A. Mutations (`ALTER TABLE … DELETE`) for everything.**
Physically removes data once the mutation completes (`system.mutations.is_done`). But it rewrites whole parts: one visitor's erasure rewrites every part that contains that store's data across 25 months. Retention by mutation rewrites the oldest parts nightly. Heavy I/O on a single-node MVP cluster; bursts of withdrawals queue many mutations.

**B. Lightweight `DELETE` for everything.**
Cheap to issue; hidden from reads at once; verification by `count()` works immediately. Physical removal waits for merges — force it with `min_age_to_force_merge_seconds` on the tables, or with `ALTER TABLE … APPLY DELETED MASK [IN PARTITION]`, a documented heavyweight mutation that forcibly removes masked rows. Retention by nightly lightweight deletes masks most of each old partition, leaving large masked parts until merges catch up.

**C. Tombstones (`ReplacingMergeTree(ver, is_deleted)`).**
To delete, write a newer row with `is_deleted=1` for each sort key. This needs the full sort key of every row to delete (read-before-delete), `FINAL` on every read (which ADR-0017 avoids on the hot report path), and physical removal only at merge. Poor fit for erasure and retention. **Not recommended.**

**D. Retention tiers in the partition key → expiry by `DROP PARTITION`.**
- Add `retention_tier UInt8` to `events` and `touchpoints`, set at insert from the store's `retention_months`. `PARTITION BY (retention_tier, toYYYYMM(occurred_at))`.
- Tiers are a small fixed set. Per the review suggestion, **13 and 25 months** (SPEC's default and maximum); optionally 3 and 6, to cover SPEC's minimum.
- Expiry is `ALTER TABLE … DROP PARTITION (tier, yyyymm)` once the partition's *newest* possible row is older than the tier. That is instant, with no rewrite and no masked parts.
- **Costs:**
  - Retention becomes tiered, not any integer from 3 to 25. That is a **SPEC §5.7 change** ("configurable, min 3, max 25"), because stores must pick a tier.
  - Monthly partitions over-retain by up to one month: a row from 1 Jan in the 13-month tier lives until the Jan partition is dropped, about 14 months later. To bound over-retention to ≤ 7 days, combine with E for the single partial month, or use weekly partitions (`toMonday`, ~110 weeks × tiers ≈ 220–440 partitions — acceptable, but more small parts at MVP volume).
  - Changing a store's tier means rewriting its rows (`INSERT … SELECT` into the new tier, then delete the old rows) — rare but heavy.
  - A new column on two tables (to be flagged in HLD §8 if chosen).
- Erasure and superseded versions still need B.

**E. Batched weekly row deletes for retention.**
- Keep SPEC's partitioning. Once a week, per table, issue one lightweight delete covering all stores, grouped by cutoff: `DELETE FROM events WHERE (store_id IN {stores with 13 m} AND occurred_at < {cutoff13}) OR (store_id IN {stores with 6 m} AND occurred_at < {cutoff6}) …`. At most 23 distinct cutoffs.
- A few statements per week instead of one per store per night.
- Over-retention ≤ 7 days, which **changes SPEC §5.7's "nightly"** to weekly for ClickHouse (Postgres can stay nightly).
- Masked rows linger until merges; `min_age_to_force_merge_seconds` bounds that.
- Keeps any-integer 3–25 retention.

## Comparison for retention (the high-volume case)

| | D — tier partitions + `DROP PARTITION` | E — batched weekly lightweight deletes | B — nightly per-store lightweight deletes |
|---|---|---|---|
| Cost per run | ~0 (metadata only) | one scan and mask per table per week | one statement per store per table per night |
| Physical removal | immediate | after merges | after merges |
| Over-retention | ≤ 1 month (monthly partitions) or ≤ 7 days (weekly, or D+E) | ≤ 7 days | ≤ 1 day |
| SPEC impact | retention becomes tiered (§5.7 change); new column | retention runs weekly for ClickHouse (§5.7 wording) | none |
| Scales to 1,000s of stores | yes | yes | no (statement count) |
| Tier or retention change | rewrite the store's rows | just a new cutoff | just a new cutoff |

## Recommendation
- **Erasure and superseded versions: B.** Lightweight `DELETE`, always with `store_id` in the predicate (ADR-0016).
  - Withdrawal erasures are batched per store (privacy-dpdp §4.5).
  - Verification is by `count() = 0` straight after the delete.
  - Set `min_age_to_force_merge_seconds` (7 days) on `events`, `touchpoints`, `identity_links`, `attribution_results` and `order_status`, so masked rows are physically gone within a bounded time. Document that bound in the erasure disclosure alongside backups.
- **Retention:** **E for MVP** (no SPEC change beyond the wording "weekly for ClickHouse", no new column, any-integer retention preserved). **D as the scale-up path** once the store count or data volume makes weekly masking expensive, since it needs the SPEC §5.7 tier decision.
  - If you would rather take the tier decision now, D with tiers {3, 6, 13, 25} plus E for the partial month is the cleanest long-term design.
- **Not C.**

## Decision
Adopt the recommendation:
- lightweight `DELETE` for erasure and superseded versions;
- weekly batched lightweight deletes for ClickHouse retention (E);
- `min_age_to_force_merge_seconds = 604800` (7 days) on `events`, `touchpoints`, `identity_links`, `attribution_results` and `order_status`;
- retention-tier partitions (D) are the documented scale-up path, not built in MVP.

**Physical purge commitment.** Deleted rows are invisible to every query immediately. They are physically removed from disk within **7 days** by forced merges ([MergeTree settings](https://clickhouse.com/docs/operations/settings/merge-tree-settings): default 0, i.e. off unless set). Backups keep them for up to 30 more days (S-5). A staging test must show masked rows gone from the parts of a partition that receives no inserts within 7 days + 1 day of scheduling slack; forced merges on old single-part partitions are the case to confirm. Fallback if that test fails: a weekly `ALTER TABLE … APPLY DELETED MASK IN PARTITION <p>` for partitions touched by erasures that week. This is a heavyweight mutation that forcibly removes masked rows ([APPLY DELETED MASK](https://clickhouse.com/docs/sql-reference/statements/alter/apply-deleted-mask)). The requirement is stated in `lld/privacy-dpdp.md` and `docs/dpdp/README.md`.

## Consequences
- One deletion primitive (lightweight `DELETE`) in `packages/clickhouse`'s query builder, which always injects `store_id`.
- SPEC §5.7 wording: ClickHouse retention runs weekly, so over-retention is ≤ 7 days. §5.10 test 6 is written against that tolerance.
- The physical-removal bound (`min_age_to_force_merge_seconds`) becomes part of what we tell merchants about erasure, next to the 30-day backup window.
- Moving to D later is a migration (add a column, repartition via `INSERT … SELECT` into a new table, swap). Plan it before data volume makes the copy expensive.
