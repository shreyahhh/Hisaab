import type { Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { createAuditLogRepository } from './auditLogRepository.js';
import { createStoreRepository } from './storeRepository.js';

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
    ],
  },
  {
    name: 'AuditLogRepository',
    methods: [
      {
        name: 'listByOrganization',
        scopeKind: 'organization',
        invoke: (db, scope, organizationId) =>
          createAuditLogRepository(db).listByOrganization(scope, organizationId),
      },
      {
        name: 'record',
        scopeKind: 'organization',
        invoke: (db, scope, organizationId) =>
          createAuditLogRepository(db).record(scope, {
            organizationId,
            actorType: 'system',
            action: 'system_scope_used',
            targetType: 'cross_tenant_test',
            targetId: 'cross_tenant_test',
          }),
      },
    ],
  },
];
