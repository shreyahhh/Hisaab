import type { Scope } from '@truepath/shared';
import type { CredentialsCipher } from '@truepath/privacy';
import type { Db } from '../client.js';
import { createAuditLogRepository } from './auditLogRepository.js';
import { createDpaAcceptanceRepository } from './dpaAcceptanceRepository.js';
import { createDsrRequestRepository } from './dsrRequestRepository.js';
import { createIntegrationRepository } from './integrationRepository.js';
import { createStoreRepository } from './storeRepository.js';
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
