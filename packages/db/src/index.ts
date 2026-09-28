// PostgreSQL schema (Drizzle, ADR-0011), migrations, and (from M0-4) the mandatory scoped
// repository layer (ADR-0016) that every store/org-scoped query goes through. Only this package,
// packages/clickhouse and packages/auth may import a raw DB client (eslint.config.js data-access
// boundary rule).

export * as schema from './schema/index.js';
export { createDb } from './client.js';
export type { Db } from './client.js';
export {
  resolveStoreOrganization,
  resolveStoreByShopDomain,
  type ResolvedStore,
} from './scopeResolution.js';
export { createSystemScope, type CreateSystemScopeOptions } from './systemScope.js';
export { jobScope } from './jobScope.js';
export {
  createStoreRepository,
  ShopLinkedToAnotherOrganizationError,
  type StoreRepository,
  type StoreRow,
  type UpsertStoreByShopDomainInput,
} from './repositories/storeRepository.js';
export {
  createIntegrationRepository,
  type IntegrationRepository,
  type IntegrationRow,
  type UpsertShopifyIntegrationInput,
} from './repositories/integrationRepository.js';
export {
  createDsrRequestRepository,
  type CreateDsrRequestFromWebhookInput,
  type DsrRequestRepository,
  type DsrRequestRow,
} from './repositories/dsrRequestRepository.js';
export {
  createOrderRepository,
  type ApplyOrderSnapshotInput,
  type ApplyOrderSnapshotResult,
  type OrderRepository,
  type OrderRow,
} from './repositories/orderRepository.js';
export {
  createWebhookDeliveryRepository,
  type RecordWebhookDeliveryInput,
  type WebhookDeliveryKey,
  type WebhookDeliveryRepository,
} from './repositories/webhookDeliveryRepository.js';
export {
  createAuditLogRepository,
  DEFAULT_AUDIT_PAGE_SIZE,
  InvalidAuditCursorError,
  MAX_AUDIT_PAGE_SIZE,
  type AuditLogPage,
  type AuditLogRepository,
  type AuditLogRow,
  type DbExecutor,
  type ListAuditLogOptions,
} from './repositories/auditLogRepository.js';
export {
  createDpaAcceptanceRepository,
  type DpaAcceptanceRepository,
  type DpaAcceptanceRow,
  type RecordDpaAcceptanceInput,
} from './repositories/dpaAcceptanceRepository.js';
export {
  repositoryRegistry,
  type RepositoryDescriptor,
  type RepositoryMethodDescriptor,
  type ScopeKind,
} from './repositories/registry.js';
