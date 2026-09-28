# apps/dashboard — Dashboard

React + Vite SPA (ADR-0010): shadcn/ui (`base-sera` style, Base UI primitives) with the lime theme,
TanStack Router (code-based route tree, `src/router.tsx`) and TanStack Query.

See [`docs/how-to-run-dashboard.md`](../../docs/how-to-run-dashboard.md) for exact commands to run
this against a real local API.

## What's real (dashboard-shell)

Sign up / log in / log out; app shell (sidebar, org switcher, user menu, light/dark toggle);
organization overview; team & invites (list, invite with role ceilings, role change, remove);
integrations (connect Shopify — a real OAuth redirect, not a fetch — list, disconnect); audit log
(filters, cursor pagination); DPA accept. Analytics/Attribution/Orders are empty-state placeholders
until the reporting API (M3-3/M3-4) exists — see `src/pages/placeholders.tsx`.

The full onboarding wizard, report screens, order journeys and RTO insights from SPEC §11 and
`docs/architecture/lld/dashboard.md` land with M3-4, once the endpoints they need exist.

## Layout

- `src/router.tsx` — the route tree.
- `src/pages/*` — one file per screen.
- `src/components/` — app-level components (`app-shell.tsx`, `org-switcher.tsx`, `user-menu.tsx`);
  `src/components/ui/*` is shadcn-generated, regenerate with `pnpm dlx shadcn@latest add <name>`
  rather than hand-editing where possible.
- `src/lib/api.ts` — the one `apiFetch`-style wrapper every screen goes through (dashboard.md §2.2):
  credentials included, zod-parsed responses.
- `src/lib/session.ts` — `useMe()` and the (non-authoritative, UI-only) last-viewed-org preference.
