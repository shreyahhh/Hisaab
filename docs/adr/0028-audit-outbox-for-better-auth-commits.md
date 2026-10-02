# 0028. A transactional outbox behind Better Auth audit writes

## Status
Accepted (2026-10-02; supersedes [ADR-0021](0021-audit-writes-after-better-auth-commits.md); issue #13)

## Context
ADR-0021 established that, for every Better Auth action we audit, the route calls Better Auth
first and — once it has committed — writes the audit row through `AuditService.afterCommit` /
`afterCommitPlatform`, retried once. ADR-0021 named the trade-off plainly: if both write attempts
fail, the only record is the `audit_write_failed` log line, recovered by hand; if the process dies
before the write is even attempted, there is no record at all, and the row can only be
reconstructed from Better Auth's own tables. It closed with: "The durable fix is a transactional
outbox, tracked in #13." This ADR is that fix.

### Why not the outbox the issue originally sketched
Issue #13 proposed writing the *intent* to durable storage **before** calling Better Auth, then
calling Better Auth, then completing the intent on success. That ordering closes the crash window
completely — but it has an unresolved problem the issue's own text flags: several actions'
`audit_log.target_id` is a value Better Auth only returns *after* it succeeds (an invitation's new
id, from `createInvitation`). Recording intent before the call means not knowing that id yet, so
completing the intent later would require a sweeper that *finds* the right Better Auth row by other
means (matching on email, organization and a time window) rather than simply writing what it
already knows. That reconstruction logic is itself a source of bugs — a near-miss match writes the
wrong target id into a permanent audit trail — and is the kind of modelling decision this ADR
chooses not to take on unreviewed.

## Decision
The entry is captured **immediately after Better Auth's commit**, at exactly the point ADR-0021's
`afterCommit`/`afterCommitPlatform` already run — by then every field (including a freshly-minted
target id) is fully known. From there:

1. **Enqueue**: insert the complete entry into a new `audit_outbox` table (`status='pending'`). This
   is one fast, single-statement insert — the gap between Better Auth's commit and this statement is
   local JS control flow with no `await` in between, not a network round trip. If this insert itself
   fails, it is retried once; if both attempts fail, nothing durable exists and this is reported the
   same way ADR-0021's complete-failure case was (manual recovery from the log line) — see
   "Remaining gap" below.
2. **Complete**: lock the outbox row (`SELECT … FOR UPDATE`), and if it is still `pending`, insert
   into `audit_log` through the one validated path (`insertAuditRow`) and mark the row `done`, all in
   one transaction. Retried once on failure, with the same 100 ms delay as before. `complete` is
   idempotent: a second call for an already-`done` (or `abandoned`) row is a no-op that returns the
   existing result, so retrying it — from the original request, or later from the sweep — is always
   safe. A metadata-validation failure (a bug, not a transient fault) marks the row `abandoned`
   instead of leaving it `pending` forever, and is not retried, same as ADR-0021.
3. **Sweep**: `apps/api` runs an in-process periodic sweep (`startAuditOutboxSweep`, every 5
   minutes — a backstop, not the primary path) that completes any row still `pending` after a 60
   second grace period (long enough that an in-flight request's own retry has certainly finished
   either way), and deletes `done`/`abandoned` rows older than 7 days (the `audit_log` row, once
   written, is the permanent record — S-4's ≥ 1 year retention applies there, not to this outbox).

This is a plain periodic function, not a new BullMQ queue: it needs no cross-process distribution
(`apps/api` already runs continuously), and a new queue name needs HLD §8 sign-off this ticket
doesn't claim. The audited `SystemScope` it runs under (`audit_outbox_sweep`) is a new entry in
`SYSTEM_REASONS`, following the same per-ticket growth pattern as `attribution_confidence_backfill`
and the others before it.

## The trade-off, plainly
**This closes both of ADR-0021's named gaps down to one, much narrower one — it does not close the
gap completely.**

- *"If the audit write fails twice, there is no row in `audit_log`. Recovery is manual."* — **Closed.**
  The row is already durable in `audit_outbox` before either completion attempt runs; the sweep
  finishes it automatically. The `audit_write_failed` report still fires on two failed completion
  attempts, now carrying the `outboxId`, so the alert becomes visibility into a self-healing delay,
  not the only path to recovery — exactly SPEC #13's acceptance criterion.
- *"If the process dies between Better Auth's commit and the audit write, there is no log line
  either."* — **Narrowed, not closed.** In ADR-0021 this gap was the whole span between the commit
  and a (possibly network-bound, retried) write. Here it is the span between Better Auth's `await`
  resolving and the next synchronous line of JS executing the outbox insert — no I/O, no `await`, in
  practice indistinguishable from atomic. Closing it completely would mean wrapping Better Auth's
  own commit in a transaction we control, which ADR-0021 already investigated and ruled out (Better
  Auth's organization-plugin hooks don't run inside its transaction, in 1.7.6).
- A **new** failure mode this design introduces: the outbox *enqueue* itself can fail (same DB, same
  failure modes as the old direct write). If both enqueue attempts fail, nothing durable exists —
  this is reported exactly like ADR-0021's old complete-failure case (full entry, no `outboxId`,
  manual recovery). In practice this converts what was previously *two* ways to silently lose a row
  (slow completion, or dying before trying) into *one* narrow one (the enqueue itself failing), which
  is strictly less exposure than before.
- The sweep's 5-minute interval and 7-day outbox retention are both tunable constants
  (`AUDIT_OUTBOX_SWEEP_INTERVAL_MS`, `AUDIT_OUTBOX_RETENTION_MS` in `apps/api/src/auditOutboxSweep.ts`),
  chosen as a reasonable backstop cadence, not derived from a specific SLA.

## Consequences
- New table `audit_outbox` (`packages/db/src/schema/privacy.ts`), new repository
  `AuditOutboxRepository` (`enqueue`, `enqueuePlatform`, `complete`, `listPending`,
  `deleteFinished` — the last two cross-tenant by nature, requiring `SystemScope`, same as
  `WebhookDeliveryRepository.pruneOlderThan`).
- `apps/api/src/audit.ts`'s `createAuditService` now takes the outbox repository as a required
  second argument; every call site (`app.ts`, `index.ts`, `testApp.ts`) was updated.
- A new `SystemReason`, `audit_outbox_sweep`.
- `AuditFailureReport` gained an optional `outboxId` field: present means a sweep will finish the
  row automatically; absent means ADR-0021's original manual-recovery case.
- ADR-0021 is superseded, not deleted — its account of *why* audit rows can't be atomic with Better
  Auth's own commit (the hooks don't run inside its transaction) still holds and this ADR doesn't
  repeat it.
