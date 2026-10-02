# 0021. Audit writes for Better Auth actions: after the commit, retried once, reported on failure

## Status
Superseded by [ADR-0028](0028-audit-outbox-for-better-auth-commits.md) (2026-10-02; issue #13's
transactional outbox). This record's account of why the audit row can't be made atomic with Better
Auth's own commit (its organization-plugin hooks don't run inside its transaction) still holds and
is not repeated there. Originally: Accepted (2026-09-26; refines privacy-dpdp.md §7 "audit writes are
synchronous in the request transaction" for actions Better Auth performs)

## Context
Several audited actions are carried out by Better Auth, which commits its own change: creating and
accepting invitations, changing and removing members, and signing in (the session it creates). An
audit row that is not committed with the action can be lost if the audit write fails afterwards, and
a 500 at that point would tell the client that something failed which in fact happened.

We checked whether the row can instead be written atomically with the action, using Better Auth
1.7.6's organization plugin (`organizationHooks`):

- **The hooks do not run inside a transaction.** Every `after*` hook (`afterCreateInvitation`,
  `afterUpdateMemberRole`, `afterRemoveMember`, `afterAcceptInvitation`, …) is called after the
  adapter operation has returned. The one transaction in these flows is `acceptInvitation`'s member
  creation, and `afterAcceptInvitation` runs after that callback has committed.
- **Transactions are off in our adapter.** `drizzleAdapter` only uses `db.transaction` when
  `transaction: true` is set, and we don't set it. Turning it on would not move the hooks inside it.
- **The transaction handle isn't ours.** Inside Better Auth's transaction the adapter is a Better
  Auth wrapper around the Drizzle transaction, not something our `audit_log` repository can use.

So there is no route to atomic audit rows for these actions without forking or patching Better Auth.

## Decision
For every Better Auth action we audit, the route calls Better Auth first, and once it has committed,
records the audit row through `AuditService.afterCommit` / `afterCommitPlatform` (`apps/api/src/audit.ts`):

1. Write the row. On failure, retry once (100 ms later).
2. If it still fails, **return the real response anyway**, and report the failure as one structured
   JSON line on stderr: `{"event":"audit_write_failed","alert":"audit_write_failed","attempts":2,…}`
   carrying the complete intended entry (organization, action, actor, target, metadata) so the row can
   be inserted by hand. The log pipeline alerts on `alert == "audit_write_failed"`. Metadata that failed
   *validation* is left out of the report, since it may hold what the check exists to keep out, and is not
   retried (it is a bug, not a fault).
3. A failing reporter never turns the request into an error either.

| Better Auth action | Route | Audit action |
|---|---|---|
| `createInvitation` | after-commit | `member_invited` |
| `acceptInvitation` | after-commit | `member_invite_accepted` |
| `updateMemberRole` | after-commit | `member_role_changed` |
| `removeMember`, `leaveOrganization` | after-commit | `member_removed` |
| `signInEmail` (success) | after-commit, platform | `login_succeeded` |
| `signInEmail` (rejected) | after-commit, platform | `login_failed` (no state was committed; the client gets the 401 either way) |

Our own actions are different: viewing the audit log is not a committed change, and personal-data
views must not be returned unaudited, so `audit_log_viewed` is written before the response and its
failure fails the request. Writes we perform ourselves (settings changes, DSRs, exports) will use
`createAuditLogRepository(tx)` in the same transaction as the change.

## The trade-off, plainly
**A Better Auth action can succeed without an audit row.** The action and its audit row are two
separate commits, and we accept that the second can fail after the first has happened. The client is
told the truth (the action worked); the audit trail is what may be missing.

- If the audit write fails twice, the row is **not** in `audit_log`. The only record is the
  `audit_write_failed` log line, which carries the complete intended entry. **Recovery is manual, from that
  log line**: insert the row by hand from the `entry` field.
- If the process dies between Better Auth's commit and the audit write, there is **no log line either**.
  The only evidence is Better Auth's own tables (the new invitation, the changed membership role, the
  removed membership, the new session), and the row can only be reconstructed from those.
- The first case is only noticed if the `audit_write_failed` alert exists and fires (deploy prerequisite, #15).
  The second is not detected at all.

We accept this for the MVP because the alternatives are worse for users: failing the request would report
an error for a change that happened, and Better Auth offers no way to make the two atomic. The durable fix
is a transactional outbox, tracked in #13. Until then this is a known gap against S-4 and should be raised
with counsel alongside the audit design.

## Consequences
- A crash between Better Auth's commit and the audit insert, or an audit outage longer than the retry,
  loses that row from `audit_log`. Recovery is from the `audit_write_failed` log line where one exists
  (#15 alerts on it), and from Better Auth's own tables where none does. Accepted for the MVP: see
  "The trade-off, plainly".
- The outbox that would close the gap is #13 (not built for the MVP).
- `AUDIT_ACTION_OWNERS` and its coverage test keep this table honest as actions move from pending to
  implemented.
