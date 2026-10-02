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
  type ConfirmIndiaOptInResult,
  type StoreRepository,
  type StoreRow,
  type UpsertStoreByShopDomainInput,
} from './repositories/storeRepository.js';
export {
  createIntegrationRepository,
  type BackfillStatePatch,
  type IntegrationRepository,
  type IntegrationRow,
  type MetaSettingsPatch,
  type MetaWarmupStatePatch,
  type ShopifySettingsPatch,
  type UpsertMetaIntegrationInput,
  type UpsertShopifyIntegrationInput,
} from './repositories/integrationRepository.js';
export {
  createAdAccountRepository,
  type AdAccountRepository,
  type AdAccountRow,
  type UpsertAdAccountInput,
} from './repositories/adAccountRepository.js';
export {
  createMetaWarmupSchedulingRepository,
  type MetaWarmupSchedulingRepository,
  type WarmupStore,
} from './repositories/metaWarmupSchedulingRepository.js';
export {
  createShopifyReconcileSchedulingRepository,
  type ReconcileStore,
  type ShopifyReconcileSchedulingRepository,
} from './repositories/shopifyReconcileSchedulingRepository.js';
export {
  createDsrRequestRepository,
  type AppendFollowupInput,
  type CompleteDsrRequestInput,
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
  createOrganizationRepository,
  type OrganizationRepository,
  type OrganizationRow,
} from './repositories/organizationRepository.js';
export {
  createOrgDeletionRepository,
  type EraseMembersAndInvitesResult,
  type OrgDeletionRepository,
} from './repositories/orgDeletionRepository.js';
export {
  publishCollectorConfig,
  deleteCollectorConfig,
  noticeVersionOf,
  type CollectorConfigDeps,
  type CollectorConfigSink,
  type CollectorConfigDeleteSink,
} from './collectorConfig.js';
export {
  createCollectorConfigRepository,
  type CollectorConfigRepository,
  type PublishableStore,
} from './repositories/collectorConfigRepository.js';
export {
  createSuppressionRebuildRepository,
  SystemScopeRequiredError,
  type ActiveSuppressionRow,
  type ListActiveSuppressionsOptions,
  type SuppressionRebuildRepository,
} from './repositories/suppressionRebuildRepository.js';
export {
  createChannelRuleRepository,
  type ChannelRuleRepository,
  type ChannelRuleRow,
} from './repositories/channelRuleRepository.js';
export {
  createEventEffectsRepository,
  type ApplyEventEffectsInput,
  type ApplyEventEffectsResult,
  type ConsentChange,
  type ConsentRecordInput,
  type EventEffectsRepository,
} from './repositories/eventEffectsRepository.js';
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
  createConsentRecordRepository,
  type ConsentRecordRepository,
  type ConsentRecordRow,
} from './repositories/consentRecordRepository.js';
export {
  createSuppressedIdentityRepository,
  type AddSuppressionInput,
  type SuppressedIdentityRepository,
} from './repositories/suppressedIdentityRepository.js';
export {
  createCapiDispatchLogRepository,
  type CapiDispatchLogRepository,
} from './repositories/capiDispatchLogRepository.js';
export {
  createDsrStoreErasureRepository,
  type DsrStoreErasureRepository,
  type EraseStoreResult,
} from './repositories/dsrStoreErasureRepository.js';
export {
  repositoryRegistry,
  type RepositoryDescriptor,
  type RepositoryMethodDescriptor,
  type ScopeKind,
} from './repositories/registry.js';
