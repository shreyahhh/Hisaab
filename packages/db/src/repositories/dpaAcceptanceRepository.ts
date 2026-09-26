import { and, eq } from 'drizzle-orm';
import { assertOrganizationInScope, type Scope } from '@truepath/shared';
import { dpaAcceptances } from '../schema/index.js';
import type { DbExecutor } from './auditLogRepository.js';

export type DpaAcceptanceRow = typeof dpaAcceptances.$inferSelect;

export interface RecordDpaAcceptanceInput {
  readonly organizationId: string;
  readonly dpaVersion: string;
  /** Must be the signed-in user the scope was built for: nobody accepts on someone else's behalf. */
  readonly acceptedByUserId: string;
  /** IPv4 /24 or IPv6 /48 (SPEC §5.4), already truncated by the caller. Never a full IP. */
  readonly ipTruncated: string | null;
}

export interface DpaAcceptanceRepository {
  /**
   * Records that the organization accepted `dpaVersion`. Idempotent: if that version is already
   * accepted, the existing row comes back with `created: false` and nothing is written, so a repeat
   * (or a concurrent second request) never produces a second row or a second audit entry.
   */
  record(
    scope: Scope,
    input: RecordDpaAcceptanceInput,
  ): Promise<{ readonly row: DpaAcceptanceRow; readonly created: boolean }>;
  /** The organization's acceptance of exactly `dpaVersion`, or null. An older version does not count. */
  findForVersion(
    scope: Scope,
    organizationId: string,
    dpaVersion: string,
  ): Promise<DpaAcceptanceRow | null>;
}

/**
 * The only sanctioned way to read or write `dpa_acceptances` (ADR-0016). Takes a `DbExecutor` so the
 * acceptance can commit in the same transaction as its audit row.
 */
export function createDpaAcceptanceRepository(executor: DbExecutor): DpaAcceptanceRepository {
  async function findForVersion(scope: Scope, organizationId: string, dpaVersion: string) {
    assertOrganizationInScope(scope, organizationId);
    const rows = await executor
      .select()
      .from(dpaAcceptances)
      .where(
        and(
          eq(dpaAcceptances.organizationId, organizationId),
          eq(dpaAcceptances.dpaVersion, dpaVersion),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  return {
    findForVersion,

    async record(scope, input) {
      assertOrganizationInScope(scope, input.organizationId);
      if (scope.kind !== 'tenant' || scope.userId !== input.acceptedByUserId) {
        throw new Error('record: a DPA is accepted by the signed-in user, in their own scope');
      }

      const inserted = await executor
        .insert(dpaAcceptances)
        .values({
          organizationId: input.organizationId,
          dpaVersion: input.dpaVersion,
          acceptedByUserId: input.acceptedByUserId,
          ipTruncated: input.ipTruncated,
        })
        .onConflictDoNothing({ target: [dpaAcceptances.organizationId, dpaAcceptances.dpaVersion] })
        .returning();
      const created = inserted[0];
      if (created) return { row: created, created: true };

      const existing = await findForVersion(scope, input.organizationId, input.dpaVersion);
      if (!existing) throw new Error('record: acceptance conflicted but no row was found');
      return { row: existing, created: false };
    },
  };
}
