import {
  AUDIT_ACTIONS,
  AUDIT_METADATA_SCHEMAS,
  type AuditActionName,
  type OrganizationAuditEntry,
  type PlatformAuditEntry,
  type Scope,
} from '@truepath/shared';
import { findPii, SENSITIVE_KEY_PATTERNS } from './redaction.js';

// The audit-log writer's contract and its metadata check (privacy-dpdp.md §2.1, SPEC S-4). This
// package holds the interface and the validation, with no database dependency (the collector uses
// this package and has no Postgres connection); the Postgres implementation is `createAuditLogger`
// in @truepath/db, the only code that writes `audit_log`.

export type AuditMetadata = Readonly<Record<string, string | number | boolean>>;

export interface AuditLogger {
  /**
   * Writes an entry for an organization. `scope` must cover `entry.organizationId` (a TenantScope for
   * that organization, or a SystemScope); a scope that doesn't throws TenantScopeViolationError.
   */
  write(scope: Scope, entry: OrganizationAuditEntry): Promise<void>;
  /**
   * Writes a platform-wide entry (no organization): only the actions in PLATFORM_AUDIT_ACTIONS,
   * enforced by the type and again at runtime. Needs no scope: there is no tenant boundary.
   */
  writePlatform(entry: PlatformAuditEntry): Promise<void>;
}

/**
 * Thrown for metadata that doesn't match its action's schema, or that the PII backstop flags. It
 * names the action and the offending paths, never the values: this error gets logged.
 */
export class AuditMetadataError extends Error {
  constructor(
    readonly action: string,
    readonly reasons: readonly string[],
  ) {
    super(`Invalid audit metadata for ${action}: ${reasons.join('; ')}`);
    this.name = 'AuditMetadataError';
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function isAuditAction(action: string): action is AuditActionName {
  return (AUDIT_ACTIONS as readonly string[]).includes(action);
}

/**
 * Checks `metadata` against the schema for `action` and returns it parsed. The schema is the real
 * check: strict objects, so an unexpected key (an `email`, a hash) fails, and every value has a
 * type, enum or format. The scan after it is a backstop for the free-form maps
 * (`retention_run`, `system_scope_used`): no sensitive key names, and no string that looks like an
 * email, a phone number or a hash (UUIDs are ids and are masked first, since their digit runs
 * resemble phone numbers).
 */
export function validateAuditMetadata(action: string, metadata: unknown): AuditMetadata {
  if (!isAuditAction(action)) throw new AuditMetadataError(action, ['unknown action']);
  const parsed = AUDIT_METADATA_SCHEMAS[action].safeParse(metadata ?? {});
  if (!parsed.success) {
    throw new AuditMetadataError(
      action,
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`),
    );
  }
  const data = parsed.data as AuditMetadata;

  const reasons: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      reasons.push(`${key}: sensitive key name`);
    }
    if (typeof value === 'string') {
      for (const finding of findPii(value.replace(UUID, '<id>'))) {
        reasons.push(`${key}: looks like ${finding.kind}`);
      }
    }
  }
  if (reasons.length > 0) throw new AuditMetadataError(action, reasons);
  return data;
}
