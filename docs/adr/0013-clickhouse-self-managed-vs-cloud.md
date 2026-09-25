# 0013. ClickHouse hosting: self-managed EC2 vs ClickHouse Cloud

## Status
Accepted (2026-09-24), **conditional** — **B. ClickHouse Cloud in ap-south-1** (SPEC §15 item 3)

## Context
ClickHouse holds events, touchpoints, identity links, ad spend, attribution credits and order-status projections (ADR-0003). It must run in India (SPEC §5.9) and support:
- lightweight deletes with forced merges for physical purge ≤ 7 days, plus `APPLY DELETED MASK` as fallback (ADR-0015);
- `ReplacingMergeTree` semantics (ADR-0017);
- daily backups with 30-day retention (S-5).

The team is 3–4 engineers on a 14-week plan; MVP runs a single node (HLD §7).

## Options
**A. Self-managed on EC2 (single node, ap-south-1)**
- Lowest direct cost; full control of versions and settings; no additional sub-processor.
- We own backups (e.g. `BACKUP … TO S3`), upgrades, monitoring, disk sizing and recovery drills. A single node is a single point of failure (HLD §11).

**B. ClickHouse Cloud in AWS ap-south-1**
- **ap-south-1 (Mumbai) is supported, public, with no tier restriction** ([supported regions](https://clickhouse.com/docs/cloud/reference/supported-regions)).
- Managed backups, upgrades, scaling and HA; separation of storage and compute.
- Cost is higher and usage-based; ClickHouse Inc. becomes a **sub-processor** (data stays in Mumbai; listed in `docs/dpdp/subprocessors.md`).
- Cloud's engine variants (`Shared*MergeTree`) need confirming for our settings (`min_age_to_force_merge_seconds`, lightweight deletes, `APPLY DELETED MASK`) in staging.

**C. Self-managed now, Cloud later**
- Starts cheap; migration later via `INSERT … SELECT` or backup/restore — a planned cut-over with dual-write or downtime.

## Recommendation
**B. ClickHouse Cloud in ap-south-1.**
- For a small team, managed backups, upgrades and HA remove the largest operational risk (the single-node SPOF in HLD §11).
- Data residency is preserved.
- **Condition**: a staging test confirms the ADR-0015 purge behaviour and the ADR-0017 backstop on Cloud's engines before M1-6. If it fails, fall back to A.

## Decision
**ClickHouse Cloud, AWS ap-south-1**:
- **the smallest tier, with idle scaling** (auto-idle when unused), sized up only on measured load;
- **backups kept in the Mumbai region**, so no backup copy leaves India;
- private connectivity from the VPC.

**Condition**: the staging test must pass before M1-6 (the first ClickHouse writes):
- lightweight deletes + `min_age_to_force_merge_seconds` purge masked rows within 7 days on Cloud's engines, or `APPLY DELETED MASK` works as the fallback (ADR-0015);
- the `ReplacingMergeTree` dedupe backstop behaves as specified (ADR-0017).

If it fails, fall back to **A (self-managed single node on EC2)** with no other design change.

## Consequences
- Add ClickHouse Inc. to the confirmed sub-processors (DPA update, merchant notice of the change).
- Budget line for Cloud usage, with a cost alarm.
- HLD §7 diagram: ClickHouse becomes a managed endpoint via PrivateLink/VPC peering in ap-south-1 (**VERIFY** the private connectivity option in staging).

## Addendum (2026-09-25) — local dev image version

M0-3's ClickHouse migrations (`packages/clickhouse`) were first verified against `clickhouse/clickhouse-server:24.8-alpine` in `docker-compose.yml`, and hit `BAD_TTL_EXPRESSION` on a `TTL` clause over a `DateTime64` column (fixed by casting with `toDateTime(...)` — a longstanding ClickHouse requirement, not version-specific).

While fixing that, checked what version ClickHouse Cloud currently runs and what ADR-0015's features need:
- Lightweight `DELETE` + `APPLY DELETED MASK`: GA since **23.3** (introduced experimental in 22.8).
- `min_age_to_force_merge_seconds`: stable since well before 23.x.
- So **24.8 already had every feature ADR-0015 needs** — this addendum is not a functional fix.
- Current ClickHouse stable/Cloud-tracked release as of 2026-09 is **26.8 (LTS)**, per [clickhouse.com/docs/resources/changelogs/cloud/2026](https://clickhouse.com/docs/resources/changelogs/cloud/2026) and the `clickhouse/clickhouse-server` image tags on Docker Hub.

**Decision**: bump the local dev image to `clickhouse/clickhouse-server:26.8-alpine` (26.8 LTS), so the staging-parity condition above is tested against something closer to what Cloud actually runs, rather than a build that's ~2 years behind. No further ADR-0015 feature gaps found at either version.

