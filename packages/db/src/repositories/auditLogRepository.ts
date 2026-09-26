import { and, desc, eq, getTableColumns, gte, lte, sql, type SQL } from 'drizzle-orm';
import {
  assertOrganizationInScope,
  AUDIT_ACTIONS,
  isPlatformAuditAction,
  type AuditActionName,
  type AuditActorType,
  type OrganizationAuditEntry,
  type PlatformAuditEntry,
  type Scope,
} from '@truepath/shared';
import { validateAuditMetadata, type AuditLogger } from '@truepath/privacy';
import type { Db } from '../client.js';
import { auditLog } from '../schema/index.js';

export type AuditLogRow = typeof auditLog.$inferSelect;
/** A `Db` or a transaction on it, so an audit row can commit atomically with the change it records. */
export type DbExecutor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export const DEFAULT_AUDIT_PAGE_SIZE = 50;
export const MAX_AUDIT_PAGE_SIZE = 200;

interface AuditRowInput {
  readonly organizationId: string | null;
  readonly action: string;
  readonly actorUserId?: string | null | undefined;
  readonly actorType: AuditActorType;
  readonly targetType: string;
  readonly targetId: string;
  readonly metadata?: unknown;
}

/**
 * The one place an `audit_log` row is inserted (the repository's writers and `createSystemScope`
 * both call it), so every row passes the per-action metadata check (privacy-dpdp.md §2.1: ids,
 * enums and counts only). Returns the new row's id.
 */
export async function insertAuditRow(executor: DbExecutor, input: AuditRowInput): Promise<string> {
  const metadata = validateAuditMetadata(input.action, input.metadata);
  const [row] = await executor
    .insert(auditLog)
    .values({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorType,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata,
    })
    .returning({ id: auditLog.id });
  if (!row) throw new Error('insertAuditRow: audit_log insert did not return an id');
  return row.id;
}

// ---- Reading --------------------------------------------------------------------------------

export interface ListAuditLogOptions {
  /** Inclusive bounds on `created_at`. */
  readonly from?: Date;
  readonly to?: Date;
  readonly action?: AuditActionName;
  /** The `nextCursor` of the previous page. */
  readonly cursor?: string;
  /** 1 to MAX_AUDIT_PAGE_SIZE; defaults to DEFAULT_AUDIT_PAGE_SIZE. */
  readonly limit?: number;
}

export interface AuditLogPage {
  /** Newest first. */
  readonly items: AuditLogRow[];
  /** Pass as `cursor` for the next page; null when this was the last one. */
  readonly nextCursor: string | null;
}

export class InvalidAuditCursorError extends Error {
  constructor() {
    super('Invalid audit log cursor');
    this.name = 'InvalidAuditCursorError';
  }
}

// The cursor is opaque to callers: a versioned, base64url-encoded position (created_at at full
// microsecond precision, then id) in the newest-first order. It is not signed — it only moves the
// window within the organization the query is already scoped to.
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(time: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, t: time, i: id })).toString('base64url');
}

function decodeCursor(cursor: string): { time: string; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const { v, t, i } = parsed as { v?: unknown; t?: unknown; i?: unknown };
    if (v === 1 && typeof t === 'string' && typeof i === 'string') {
      if (CURSOR_TIME.test(t) && CURSOR_ID.test(i)) return { time: t, id: i };
    }
  } catch {
    // fall through
  }
  throw new InvalidAuditCursorError();
}

// ---- Repository -----------------------------------------------------------------------------

export interface AuditLogRepository extends AuditLogger {
  /** Newest-first page of an organization's audit log. Requires a Scope that covers it (ADR-0016). */
  list(scope: Scope, organizationId: string, options?: ListAuditLogOptions): Promise<AuditLogPage>;
}

/**
 * The only sanctioned way to read or write `audit_log` (ADR-0016, SPEC S-4). It has no update or
 * delete: audit rows are append-only from the application's side. (Retention deletes them under a
 * SystemScope in M4-3; database-level immutability is a separate hardening ticket.)
 */
export function createAuditLogRepository(executor: DbExecutor): AuditLogRepository {
  return {
    async write(scope: Scope, entry: OrganizationAuditEntry) {
      assertOrganizationInScope(scope, entry.organizationId);
      if (isPlatformAuditAction(entry.action)) {
        throw new Error(`write: ${entry.action} is a platform audit action; use writePlatform`);
      }
      await insertAuditRow(executor, entry);
    },

    async writePlatform(entry: PlatformAuditEntry) {
      // The type already restricts this; the check is for callers that got past it.
      if (!isPlatformAuditAction(entry.action)) {
        throw new Error(`writePlatform: ${entry.action} is not a platform audit action`);
      }
      await insertAuditRow(executor, { ...entry, organizationId: null });
    },

    async list(scope, organizationId, options = {}) {
      assertOrganizationInScope(scope, organizationId);
      if (options.action && !(AUDIT_ACTIONS as readonly string[]).includes(options.action)) {
        throw new Error('list: unknown audit action filter');
      }
      const limit = Math.min(
        Math.max(Math.trunc(options.limit ?? DEFAULT_AUDIT_PAGE_SIZE), 1),
        MAX_AUDIT_PAGE_SIZE,
      );

      const conditions: SQL[] = [eq(auditLog.organizationId, organizationId)];
      if (options.from) conditions.push(gte(auditLog.createdAt, options.from));
      if (options.to) conditions.push(lte(auditLog.createdAt, options.to));
      if (options.action) conditions.push(eq(auditLog.action, options.action));
      if (options.cursor) {
        const { time, id } = decodeCursor(options.cursor);
        conditions.push(
          sql`(${auditLog.createdAt}, ${auditLog.id}) < (${time}::timestamptz, ${id}::uuid)`,
        );
      }

      // Postgres keeps microseconds but a JS Date keeps milliseconds, so the cursor position is
      // read back as text, or rows sharing a millisecond could be skipped or repeated across pages.
      const cursorTime = sql<string>`to_char(${auditLog.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
      const rows = await executor
        .select({ ...getTableColumns(auditLog), cursorTime })
        .from(auditLog)
        .where(and(...conditions))
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const items = page.map(({ cursorTime: _cursorTime, ...row }) => row);
      return {
        items,
        nextCursor: rows.length > limit && last ? encodeCursor(last.cursorTime, last.id) : null,
      };
    },
  };
}
