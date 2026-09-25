# 0014. Pixel → Collector domain: our domain vs merchant subdomain CNAME

## Status
Accepted (2026-09-24) — **A/C: our own collector domain** (SPEC §15 item 4)

## Context
The Web Pixel sends events to `POST /v1/collect` (collector.md). SPEC §15 frames the choice as "our domain first vs merchant subdomain CNAME (better first-party persistence; more onboarding friction)". Facts that change the trade-off:
- **Persistence doesn't depend on the collector domain.** `visitor_id`, `_fbp` and `_fbc` are read and written by the pixel through `browser.cookie` / `browser.localStorage` on the **shop's** domain (ADR-0008). The Collector sets **no cookies** (collector §7).
- The strict pixel sandbox sends **`Origin: null`**, so CORS origin matching doesn't depend on the collector domain either.
- The remaining differences are **ad-blocker / tracker-list resistance** and **onboarding cost**.

## Options
**A. Our domain** (e.g. `collect.<our-domain>`)
- Zero merchant setup; one TLS certificate; one ALB (the Collector ALB with logs off, privacy-dpdp §4.11).
- More likely to appear on blocklists as the product grows, losing some events from shoppers with blockers.

**B. Merchant subdomain CNAME** (e.g. `t.<brand>.com` → our Collector ALB)
- Looks first-party to blockers, so fewer lost events.
- Per-merchant DNS change during onboarding (often needs their developer); per-merchant TLS certificates (ACM with DNS validation), subject to ALB certificate quotas; SNI routing to resolve the store; support burden when DNS breaks.
- Pixel settings must carry the per-store collector URL (already a setting: `collectorUrl`).

**C. A first, B optional later**
- Ship A; add B as an opt-in "custom tracking domain" feature once blocking loss is measured. It needs no pixel change beyond `collectorUrl`.

## Recommendation
**C.** Start on our domain; measure blocked-event loss through pixel coverage (SPEC v0.5 §11: orders with a pixel match ÷ all orders), and offer CNAME as an optional advanced setting if coverage suffers. It isn't needed for cookie persistence here, which was the main argument in SPEC §15.

## Decision
Use **our own collector domain** (`collect.<our-domain>`) for all stores. **Revisit** (option B, merchant CNAME as an opt-in "custom tracking domain") if pixel coverage is low on **desktop-heavy stores**, where ad and tracker blockers are more common than on the mobile-first traffic typical of Indian D2C.

## Consequences
- MVP onboarding has no DNS step.
- `collectorUrl` stays a per-store pixel setting, so switching a store to a CNAME later is configuration, not code.
- If B is added later: ACM certificate automation, an ALB certificate-quota check, a DNS-verification UI, and sub-processor impact are unchanged (same AWS region).
