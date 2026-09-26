// PostgreSQL schema (Drizzle, ADR-0011), migrations, and (from M0-4) the mandatory scoped
// repository layer (ADR-0016) that every store/org-scoped query goes through. Only this package,
// packages/clickhouse and packages/auth may import a raw DB client (eslint.config.js data-access
// boundary rule).

export * as schema from './schema/index.js';
export { createDb } from './client.js';
export type { Db } from './client.js';
export { resolveStoreOrganization } from './scopeResolution.js';
export { createSystemScope, type CreateSystemScopeOptions } from './systemScope.js';
export {
  createStoreRepository,
  type StoreRepository,
  type StoreRow,
} from './repositories/storeRepository.js';
export {
  createAuditLogRepository,
  type AuditLogRepository,
  type AuditLogRow,
  type RecordAuditEntryInput,
  type RecordGlobalAuditEntryInput,
  type ListAuditLogOptions,
} from './repositories/auditLogRepository.js';
export {
  repositoryRegistry,
  type RepositoryDescriptor,
  type RepositoryMethodDescriptor,
  type ScopeKind,
} from './repositories/registry.js';
