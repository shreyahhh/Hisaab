import type { Scope } from '@truepath/shared';
import type { CredentialsCipher } from '@truepath/privacy';
import type { Db } from '../client.js';
import { createAuditLogRepository } from './auditLogRepository.js';
import { createDpaAcceptanceRepository } from './dpaAcceptanceRepository.js';
import { createAdAccountRepository } from './adAccountRepository.js';
import { createChannelRuleRepository } from './channelRuleRepository.js';
import { createCapiDispatchLogRepository } from './capiDispatchLogRepository.js';
import { createDsrStoreErasureRepository } from './dsrStoreErasureRepository.js';
import { createConsentRecordRepository } from './consentRecordRepository.js';
import { createDsrRequestRepository } from './dsrRequestRepository.js';
import { createEventEffectsRepository } from './eventEffectsRepository.js';
import { createIntegrationRepository } from './integrationRepository.js';
import { createOrderRepository } from './orderRepository.js';
import { createOrganizationRepository } from './organizationRepository.js';
import { createStoreRepository } from './storeRepository.js';
import { createSuppressedIdentityRepository } from './suppressedIdentityRepository.js';
import { createWebhookDeliveryRepository } from './webhookDeliveryRepository.js';

// A resource id that never matches a real row, for scope-assertion-only harness invocations (the
// assertion throws before the query would run, so which nonexistent id is passed is immaterial).
const NEVER_MATCHES = '00000000-0000-0000-0000-000000000000';

// A cipher that must never actually run: upsertShopify's assertStoreInScope throws on a foreign
// storeId before any encryption happens, so the harness never needs a real, working cipher — only
// something typed correctly. Throwing here (rather than importing the real test cipher from
// @truepath/privacy/testing) also keeps this production file from depending on a test-only module.
const UNUSED_CIPHER: CredentialsCipher = {
  writeVersion: 'k1',
  encrypt: () => {
    throw new Error(
      'registry harness: cipher should never be invoked (scope check must run first)',
    );
  },
  decrypt: () => {
    throw new Error(
      'registry harness: cipher should never be invoked (scope check must run first)',
    );
  },
};

export type ScopeKind = 'store' | 'organization';

export interface RepositoryMethodDescriptor {
  /** Method name, for readable failure messages. */
  readonly name: string;
  /** Which kind of id this method is scoped by. */
  readonly scopeKind: ScopeKind;
  /**
   * Calls the method with `scope` and `resourceId` as the store/organization id being accessed.
   * Every scoped repository method asserts scope membership as its first step, so any other
   * required arguments can be filled with harmless placeholders by the caller.
   */
  readonly invoke: (db: Db, scope: Scope, resourceId: string) => Promise<unknown>;
}

export interface RepositoryDescriptor {
  readonly name: string;
  readonly methods: readonly RepositoryMethodDescriptor[];
}

// Every scoped Postgres repository registers its methods here. The generated cross-tenant test
// (SPEC §5.10 test 7; auth-tenancy.md §8) discovers its repository test cases from this array
// instead of a hand-maintained list — a repository added without an entry here is a repository
// the harness cannot verify (auth-tenancy.md §8: "opting out needs an allowlist entry").
export const repositoryRegistry: readonly RepositoryDescriptor[] = [
  {
    name: 'StoreRepository',
    methods: [
      {
        name: 'listByOrganization',
        scopeKind: 'organization',
        invoke: (db, scope, organizationId) =>
          createStoreRepository(db).listByOrganization(scope, organizationId),
      },
      {
        name: 'getById',
        scopeKind: 'store',
        invoke: (db, scope, storeId) => createStoreRepository(db).getById(scope, storeId),
      },
      {
        name: 'upsertByShopDomain',
        scopeKind: 'organization',
        invoke: (db, scope, organizationId) =>
          createStoreRepository(db).upsertByShopDomain(scope, {
            organizationId,
            shopDomain: 'cross-tenant-test.myshopify.com',
          }),
      },
      {
        name: 'markUninstalled',
        scopeKind: 'store',
        invoke: (db, scope, storeId) => createStoreRepository(db).markUninstalled(scope, storeId),
      },
      {
        name: 'markDeleted',
        scopeKind: 'store',
        invoke: (db, scope, storeId) => createStoreRepository(db).markDeleted(scope, storeId),
      },
    ],
  },
  {
    name: 'IntegrationRepository',
    methods: [
      {
        name: 'upsertShopify',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createIntegrationRepository(db).upsertShopify(scope, {
            storeId,
            externalAccountId: 'cross-tenant-test',
            credentialsJson: '{}',
            scopes: [],
            cipher: UNUSED_CIPHER,
          }),
      },
      {
        name: 'getByIdForOrganization',
        scopeKind: 'organization',
        invoke: (db, scope, organizationId) =>
          createIntegrationRepository(db).getByIdForOrganization(
            scope,
            organizationId,
            NEVER_MATCHES,
          ),
      },
      {
        name: 'revokeForOrganization',
        scopeKind: 'organization',
        invoke: (db, scope, organizationId) =>
          createIntegrationRepository(db).revokeForOrganization(
            scope,
            organizationId,
            NEVER_MATCHES,
          ),
      },
      {
        name: 'markUninstalled',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createIntegrationRepository(db).markUninstalled(scope, storeId),
      },
      {
        name: 'getActiveByStore',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createIntegrationRepository(db).getActiveByStore(scope, storeId, 'shopify'),
      },
      {
        name: 'listByStore',
        scopeKind: 'store',
        invoke: (db, scope, storeId) => createIntegrationRepository(db).listByStore(scope, storeId),
      },
    ],
  },
  {
    name: 'DsrRequestRepository',
    methods: [
      {
        name: 'createFromWebhook',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createDsrRequestRepository(db).createFromWebhook(scope, {
            storeId,
            type: 'store_erasure',
            identityHash: null,
            dueAt: new Date(),
            sourceRef: `cross-tenant-test-${storeId}`,
          }),
      },
      {
        name: 'listRecentByStore',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createDsrRequestRepository(db).listRecentByStore(scope, storeId, 20),
      },
      {
        name: 'beginProcessing',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createDsrRequestRepository(db).beginProcessing(scope, storeId, NEVER_MATCHES),
      },
      {
        name: 'complete',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createDsrRequestRepository(db).complete(scope, storeId, NEVER_MATCHES, {
            resultSummaryPatch: {},
            completedAt: new Date(),
          }),
      },
      {
        name: 'fail',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createDsrRequestRepository(db).fail(scope, storeId, NEVER_MATCHES),
      },
      {
        name: 'appendFollowup',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createDsrRequestRepository(db).appendFollowup(scope, storeId, NEVER_MATCHES, {
            followupKey: 'cross-tenant-test',
            visitorCount: 0,
            rowsDeleted: 0,
            at: new Date(),
          }),
      },
    ],
  },
  {
    name: 'ConsentRecordRepository',
    methods: [
      {
        name: 'listRecentByStore',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createConsentRecordRepository(db).listRecentByStore(scope, storeId, 20),
      },
      {
        name: 'deleteByVisitorHmacs',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createConsentRecordRepository(db).deleteByVisitorHmacs(scope, storeId, ['k1:x']),
      },
    ],
  },
  {
    name: 'CapiDispatchLogRepository',
    methods: [
      {
        name: 'redactLastErrorForOrders',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createCapiDispatchLogRepository(db).redactLastErrorForOrders(scope, storeId, [
            NEVER_MATCHES,
          ]),
      },
    ],
  },
  {
    name: 'DsrStoreErasureRepository',
    methods: [
      {
        name: 'eraseStore',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createDsrStoreErasureRepository(db).eraseStore(scope, storeId),
      },
    ],
  },
  {
    name: 'SuppressedIdentityRepository',
    methods: [
      {
        name: 'countByStore',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createSuppressedIdentityRepository(db).countByStore(scope, storeId),
      },
      {
        name: 'add',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createSuppressedIdentityRepository(db).add(scope, storeId, {
            identifierType: 'visitor_id',
            identifier: `k1:${'0'.repeat(64)}`,
            reason: 'erased',
            expiresAt: new Date(),
          }),
      },
    ],
  },
  {
    name: 'OrderRepository',
    methods: [
      {
        name: 'applySnapshot',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createOrderRepository(db).applySnapshot(scope, {
            storeId,
            externalOrderId: `cross-tenant-test-${storeId}`,
            createdAtPlatform: new Date(),
            totalAmountPaise: 100,
            currency: 'INR',
            paymentMethod: 'prepaid',
            refundedAmountPaise: null,
            financialStatus: null,
            fulfilmentStatus: 'unfulfilled',
            cancelledAt: null,
            pincodePrefix: null,
            phoneHashHmac: null,
            emailHashHmac: null,
            landingSite: null,
            referringSite: null,
            noteAttributes: [],
            discountCodes: [],
            sourceTimestamp: new Date(),
            eventStatus: 'created',
            rawRef: `cross-tenant-test-${storeId}`,
          }),
      },
      {
        name: 'getById',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createOrderRepository(db).getById(scope, storeId, NEVER_MATCHES),
      },
      {
        name: 'linkVisitorIfUnset',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createOrderRepository(db).linkVisitorIfUnset(scope, storeId, NEVER_MATCHES, 'v'),
      },
      {
        name: 'setAttributionConfidence',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createOrderRepository(db).setAttributionConfidence(scope, storeId, NEVER_MATCHES, 'low'),
      },
      {
        name: 'countOrdersByIdentityHash',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createOrderRepository(db).countOrdersByIdentityHash(scope, storeId, 'k1:x', new Date()),
      },
      {
        name: 'listRecentByStore',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createOrderRepository(db).listRecentByStore(scope, storeId, 20),
      },
      {
        name: 'findByIdentityHashes',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createOrderRepository(db).findByIdentityHashes(scope, storeId, ['k1:x']),
      },
      {
        name: 'findByVisitorIds',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createOrderRepository(db).findByVisitorIds(scope, storeId, ['v']),
      },
      {
        name: 'anonymiseErasedOrders',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createOrderRepository(db).anonymiseErasedOrders(scope, storeId, [NEVER_MATCHES]),
      },
      {
        name: 'unlinkVisitor',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createOrderRepository(db).unlinkVisitor(scope, storeId, [NEVER_MATCHES]),
      },
    ],
  },
  {
    name: 'AdAccountRepository',
    methods: [
      {
        name: 'upsert',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createAdAccountRepository(db).upsert(scope, {
            storeId,
            provider: 'meta',
            externalId: `cross-tenant-test-${storeId}`,
            name: 'x',
            currency: 'INR',
            timezone: 'Asia/Kolkata',
          }),
      },
      {
        name: 'listByStore',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createAdAccountRepository(db).listByStore(scope, storeId, 'meta'),
      },
    ],
  },
  {
    name: 'IntegrationRepository.meta',
    methods: [
      {
        name: 'upsertMeta',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createIntegrationRepository(db).upsertMeta(scope, {
            storeId,
            externalAccountId: 'cross-tenant-test',
            credentialsJson: '{}',
            scopes: [],
            cipher: UNUSED_CIPHER,
          }),
      },
      {
        name: 'patchMetaSettings',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createIntegrationRepository(db).patchMetaSettings(scope, storeId, { ad_account_ids: [] }),
      },
      {
        name: 'patchMetaWarmupState',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createIntegrationRepository(db).patchMetaWarmupState(scope, storeId, { calls_total: 1 }),
      },
    ],
  },
  {
    name: 'ChannelRuleRepository',
    methods: [
      {
        name: 'listByStore',
        scopeKind: 'store',
        invoke: (db, scope, storeId) => createChannelRuleRepository(db).listByStore(scope, storeId),
      },
    ],
  },
  {
    name: 'EventEffectsRepository',
    methods: [
      {
        name: 'applyStoreEffects',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createEventEffectsRepository(db).applyStoreEffects(scope, {
            storeId,
            now: new Date(),
            consentRecords: [],
            consentChanges: [],
            suppressionHits: [],
            checkoutLinks: [],
            suppressionExpiresAt: new Date(),
            withdrawalDueAt: new Date(),
          }),
      },
    ],
  },
  {
    name: 'WebhookDeliveryRepository',
    methods: [
      {
        name: 'wasAlreadyDelivered',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createWebhookDeliveryRepository(db).wasAlreadyDelivered(scope, {
            storeId,
            webhookId: `cross-tenant-test-${storeId}`,
          }),
      },
      {
        name: 'recordDelivery',
        scopeKind: 'store',
        invoke: (db, scope, storeId) =>
          createWebhookDeliveryRepository(db).recordDelivery(scope, {
            storeId,
            webhookId: `cross-tenant-test-${storeId}`,
            topic: 'app/uninstalled',
          }),
      },
    ],
  },
  {
    name: 'DpaAcceptanceRepository',
    methods: [
      {
        name: 'record',
        scopeKind: 'organization',
        invoke: (db, scope, organizationId) =>
          createDpaAcceptanceRepository(db).record(scope, {
            organizationId,
            dpaVersion: 'cross-tenant-test',
            acceptedByUserId: scope.kind === 'tenant' ? (scope.userId ?? '') : '',
            ipTruncated: null,
          }),
      },
      {
        name: 'findForVersion',
        scopeKind: 'organization',
        invoke: (db, scope, organizationId) =>
          createDpaAcceptanceRepository(db).findForVersion(
            scope,
            organizationId,
            'cross-tenant-test',
          ),
      },
    ],
  },
  {
    name: 'OrganizationRepository',
    methods: [
      {
        name: 'getById',
        scopeKind: 'organization',
        invoke: (db, scope, organizationId) =>
          createOrganizationRepository(db).getById(scope, organizationId),
      },
      {
        name: 'requestDeletion',
        scopeKind: 'organization',
        invoke: (db, scope, organizationId) =>
          createOrganizationRepository(db).requestDeletion(scope, organizationId, {
            now: new Date(),
          }),
      },
      {
        name: 'cancelDeletion',
        scopeKind: 'organization',
        invoke: (db, scope, organizationId) =>
          createOrganizationRepository(db).cancelDeletion(scope, organizationId, {
            now: new Date(),
          }),
      },
    ],
  },
  {
    name: 'AuditLogRepository',
    methods: [
      {
        name: 'list',
        scopeKind: 'organization',
        invoke: (db, scope, organizationId) =>
          createAuditLogRepository(db).list(scope, organizationId),
      },
      {
        name: 'write',
        scopeKind: 'organization',
        invoke: (db, scope, organizationId) =>
          createAuditLogRepository(db).write(scope, {
            organizationId,
            actorType: 'system',
            action: 'audit_log_viewed',
            targetType: 'cross_tenant_test',
            targetId: 'cross_tenant_test',
          }),
      },
    ],
  },
];
