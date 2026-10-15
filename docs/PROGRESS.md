# Build progress log

Running log of what's been built, verified, and decided while working unattended (CLAUDE.md
"Working unattended" clause: conservative default chosen, logged here instead of waiting on
confirmation). Newest entries at the top. Each entry should be enough for someone cold to see
what changed, why, and what's still open.

---

## 2026-10-16 — Session start: milestone audit + issue #16 closed out

### Where the project actually stood (verified by reading source, not directory names)
- **M0 (Foundations):** ~done. Monorepo, CI, Docker Compose, Postgres + ClickHouse schemas/migrations,
  auth/orgs/RBAC, `packages/privacy`, audit log, 27 Accepted ADRs, all 12 LLDs present.
- **M1 (Shopify + tracking):** ~90% done. Real OAuth install, webhooks + HMAC verify, 60→90-day
  backfill, Web Pixel extension, collector pipeline, event-workers, identity stitching. DSR/erasure
  pipeline and org-deletion scheduler (M4-scope work) already built and merged. Auth hardening
  (password reset, email verification) was the tail end of this work — see below.
- **M2 (Ad platforms + Shiprocket):** ~15%. Meta has only the M1-8 warm-up slice (read-only insights
  polling for App Review call-volume). **Google Ads and Shiprocket adapters do not exist at all.**
- **M3 (Attribution + reports):** ~0%. `packages/attribution/src/index.ts` is a 5-line placeholder.
  No `/v1/stores/:id/reports/*` routes exist.
- **M4 (CAPI + hardening):** mixed. DSR, audit trail, cross-tenant isolation tests, retention
  machinery already done (inherited from M1's privacy work pulled forward). No CAPI dispatch worker
  yet (`capi_dispatch_log` is schema-only). No breach register. No single consolidated §5.10 suite
  file (though most of its component tests exist individually, scattered across test files).

Known open blocker unrelated to this session's work: **issue #67** (Shopify OAuth session cookie
can't cross the `localhost` ↔ ngrok tunnel boundary) blocks *live* Shopify OAuth verification via a
tunnel. Doesn't block fixture-based adapter/unit work.

### Issue #16 — email verification (finished and shipped)
Was sitting staged/uncommitted at session start, functionally complete:
- Allow-listed `POST /send-verification-email` and `GET /verify-email` through Better Auth's
  route allow-list (ADR-0022), each with its audit justification in the same change.
- New `email_verified` audit action, written from `afterEmailVerification` (fires only once a
  token is verified and `emailVerified` is actually set — metadata is `target_user_id` only, never
  the email).
- `/send-verification-email` needs no audit row: no state change, constant-time response (same
  no-enumeration shape as `/request-password-reset`).

**Verification before calling it done:**
- `packages/db/dist` was stale relative to `src` (built Oct 2, schema changed Oct 3) — rebuilt.
- `pnpm test`: 688/688 passing after rebuild. One `auditTrail.test.ts > login_succeeded` failure
  seen once under full-suite parallel execution; passed in isolation and on a clean rerun of the
  full suite — confirmed pre-existing flakiness (likely parallel test files racing against the same
  live Postgres instance), **not caused by this diff**. Logged under Decisions for review below
  rather than fixed inline (out of scope for this ticket).
- `pnpm lint`: clean. Prettier flagged 2 gitignored Shopify CLI build artifacts and 1 untracked
  scratch script (`scripts/smoke/`) — neither part of this diff, left untouched.
- `pnpm typecheck`: clean.

Shipped as [PR #106](https://github.com/shreyahhh/Hisaab/pull/106) → `develop`, opened as **draft**
(matches this repo's established overnight-run convention — see
[issue #107](https://github.com/shreyahhh/Hisaab/issues/107)). **Not merged** — merging a PR requires
explicit approval per CLAUDE.md.

**CI caught a real bug the local run missed**: the first CI run on PR #106 failed —
`new row for relation "audit_log" violates check constraint "audit_log_action_check"`. The
TypeScript-side audit catalogue (`packages/shared`) had `email_verified` added, but the Postgres
migration extending the `audit_log.action` CHECK constraint was never generated, so a *freshly
migrated* database (CI) rejected the insert. My own long-lived local dev Postgres had enough prior
migration history that this didn't surface locally — a reminder that local green isn't proof against
a clean-DB CI run. Fixed by running `drizzle-kit generate` (migration `0013_audit_log_email_verified.sql`),
applying it, rerunning the full suite (688/688 green), and pushing. CI is now green
(`ci` 3m34s, `db-migrations` 41s).

### Decisions for review
1. **Flaky `auditTrail.test.ts` under full-suite concurrency** (not fixed, just flagged): one
   `login_succeeded` assertion failed once under `pnpm test`'s full parallel run, passed in
   isolation and on retry. Suggests test files share the live Postgres instance without full
   isolation between them (SPEC §14 calls for testcontainers; current setup appears to hit one
   shared Docker Compose Postgres). Worth its own ticket if it recurs — not blocking issue #16.
2. **M2 ticket order:** spec lists M2-1 (Meta) → M2-2 (Google Ads) → M2-3 (Shiprocket) with no
   hard dependency between them. Picking **Meta first** since adapter scaffolding already exists
   from the M1-8 warm-up slice — least net-new surface area to get a full sync shipped.
3. **No live credentials available** for any ad platform or Shiprocket. Per CLAUDE.md, creating
   accounts/API keys or calling paid external services needs explicit approval. Building adapters
   test-first against official API docs + recorded fixtures (nock/msw, per SPEC §14), same pattern
   as the existing Meta warm-up slice and Shopify adapter. Live end-to-end verification against a
   real ad account stays blocked until credentials are supplied (same shape as the M1 Shopify
   tunnel blocker, issue #67).

### Next up
M2-1: extend `packages/integrations/src/meta` from the M1-8 read-only warm-up slice to the full
spec'd sync (daily + intraday insights at ad level, campaign/ad set/ad breakdown, spend persisted
to `ad_spend_daily`) plus the `ad-sync-meta` BullMQ worker. Ticket restatement follows in the next
entry once scoped.
