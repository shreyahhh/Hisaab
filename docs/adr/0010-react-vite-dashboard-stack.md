# 0010. React + Vite dashboard stack (with TanStack Router)

## Status
Accepted (fixed in SPEC §3; the router added in SPEC v0.5)

## Context
The merchant dashboard (SPEC §11) is a data-heavy SPA: filterable reports, drill-down tables, charts, and an onboarding wizard. It must format INR/IST correctly and must not leak PII to analytics tools (SPEC §5.4).

## Decision
**React + Vite + TypeScript** with TanStack Query, TanStack Table, Recharts, Tailwind (SPEC §3), and **TanStack Router** (SPEC v0.5):
- **Typed search params** hold all report filters (`from`, `to`, `model`, `basis`, `level`, …), validated with the same zod schemas as the API, so views are shareable and back/forward works.
- API responses are parsed with zod from `packages/shared`.
- Formatting uses the `Intl` `en-IN` locale (`₹12,34,56,789`, `₹1.3Cr`) and `Asia/Kolkata`.
- No third-party analytics or session replay; Sentry (EU) with strict scrubbing.

Hosting: S3 + CloudFront in ap-south-1.

## Consequences
- The TanStack family shares idioms; URL state avoids storing filters in `localStorage`.
- Browser ICU differences in compact INR formatting are covered by E2E checks (dashboard §8).
- The dashboard is a separate web app, not embedded in Shopify admin (SPEC §3).
