# 0027. Meta warm-up slice: token registration via an operator CLI, not OAuth

## Status
Accepted (decided 2026-09-28 during M1-8 planning).

## Context
`meta-integration.md` §2.2/§12 (SPEC v0.5) schedules a read-only `meta-warmup` insights pull — `GET
act_<id>/insights` every 15 minutes against our test ad account and one design partner's account — to
build the ≥ 1,500 successful Marketing API calls in 15 days (< 15% errors) that Advanced Access needs
before App Review can be submitted. It is deliberately pulled into M1, ahead of the full Meta integration
(connection, CAPI), which is M2.

That leaves a gap the LLD doesn't address: `meta-warmup` needs a working ad-account access token *before*
any OAuth connect flow exists (Facebook Login for Business is M2-1). Something has to put a token in
front of the warm-up job.

Options considered:
- **A. Operator CLI, storing the token in an encrypted `integrations` row.** A `dev:meta-warmup register`
  command (stdin, never argv, mirroring `devShopifyBackfill.ts`'s pattern) that upserts a `meta`
  integration row via `IntegrationRepository.upsertMeta` (ADR-0023 envelope encryption) and an
  `ad_accounts` row. Uses the data model the LLD already specifies (`integrations` provider `meta`,
  `ad_accounts`), so M2-1's OAuth connect flow later only replaces how the row gets *written* — not its
  shape, not the warm-up job that reads it.
- **B. Env vars for the warm-up only** (`META_WARMUP_ACCESS_TOKEN`, `META_WARMUP_AD_ACCOUNT_IDS`),
  validated at boot, no database row. Simpler to stand up, but: one token for every warm-up account
  (the LLD wants our test account *and* a design partner's, i.e. two tokens); changing it needs a
  redeploy; ties spend rows to whichever store is hard-coded to read the env; and it is throwaway code
  the M2-1 OAuth flow would delete rather than extend.
- **C. Build M2-1's OAuth flow first**, and only then run the warm-up. Out of the milestone order SPEC
  §12 sets, and delays the 15-day call-history clock the warm-up exists to start early.

## Decision
**Option A.** `apps/workers/src/devMetaWarmup.ts` registers a store's Meta ad account and access token
by hand:
```sh
pnpm --filter @truepath/workers dev:meta-warmup register <storeId> <adAccountId> <name> <currency> <timezone>
pnpm --filter @truepath/workers dev:meta-warmup start  <storeId>   # registers the repeatable job
pnpm --filter @truepath/workers dev:meta-warmup run    <storeId>   # enqueues one immediate run
pnpm --filter @truepath/workers dev:meta-warmup status <storeId>   # prints non-secret state only
```
The token is read from stdin, one line, and is never a CLI argument (shell history, `ps`). It is
encrypted through the same `CredentialsCipher` (ADR-0023) as every other integration's credentials
before it is written; the CLI process holds it only for the moment between reading and encrypting it.

A store's Meta `integrations` row uses a deterministic placeholder `externalAccountId`
(`warmup-<storeId>`), not the ad account id: one store can register several ad accounts
(`settings.ad_account_ids`), and they must all land on the *same* integration row, not one row per
account. There is no real Meta business id available without OAuth to key on instead; M2-1 replaces this
placeholder with the real one once it exists (a value the row already has to migrate, same as any other
`external_account_id` update).

## Consequences
- The warm-up's data model is exactly `meta-integration.md §3`'s (`integrations` provider `meta`,
  `ad_accounts`), so M2-1 doesn't migrate anything — it starts writing to rows M1-8 already knows how to
  read.
- Nothing about this needs a new dependency, a new HLD §8 name, or a schema change: `upsertMeta`,
  `patchMetaSettings` and `patchMetaWarmupState` are new repository *methods* on the existing
  `integrations` table, in the same shape as the Shopify integration's own methods.
- The token is a long-lived Business Integration System User token (meta-integration.md §2.3: "default
  to never expire"), so there is no refresh story to build for M1-8 — unlike Shopify's OAuth tokens.
  M2-1's real OAuth tokens will need one; this ADR doesn't decide that.
- This is explicitly a **local-development / operator tool**, like `devShopifyBackfill.ts` — not a
  production onboarding path. A merchant-facing "connect Meta" flow is M2-1, unchanged by this decision.
- Follow-up (not built here): the operator CLI's `register` overwrites `settings.ad_account_ids` by
  appending, with no way to remove a misregistered account short of editing the database by hand. Low
  risk for a handful of design-partner/test accounts in M1; worth a small `deregister` command if this
  needs more than a few registrations before M2-1 lands.
