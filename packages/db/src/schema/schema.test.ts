import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle's PgTable type isn't exported cleanly for a generic helper signature
function checkNames(table: any): string[] {
  return getTableConfig(table).checks.map((c) => c.name);
}

// Unique-ness in Drizzle comes from either a uniqueIndex() or a unique().nullsNotDistinct()
// constraint — check both, since the test only cares that the name exists somewhere.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
function uniqueNames(table: any): Array<string | undefined> {
  const config = getTableConfig(table);
  const fromIndexes = config.indexes.filter((i) => i.config.unique).map((i) => i.config.name);
  const fromConstraints = config.uniqueConstraints.map((c) => c.name);
  return [...fromIndexes, ...fromConstraints];
}

describe('Postgres schema (SPEC §6.1)', () => {
  it('names every table exactly as SPEC/HLD specify', () => {
    const expected: ReadonlyArray<readonly [string, object]> = [
      ['users', schema.users],
      ['auth_accounts', schema.authAccounts],
      ['sessions', schema.sessions],
      ['auth_tokens', schema.authTokens],
      ['organizations', schema.organizations],
      ['memberships', schema.memberships],
      ['invites', schema.invites],
      ['stores', schema.stores],
      ['dpa_acceptances', schema.dpaAcceptances],
      ['integrations', schema.integrations],
      ['ad_accounts', schema.adAccounts],
      ['orders', schema.orders],
      ['order_status_events', schema.orderStatusEvents],
      ['consent_records', schema.consentRecords],
      ['dsr_requests', schema.dsrRequests],
      ['store_delivery_rates', schema.storeDeliveryRates],
      ['suppressed_identities', schema.suppressedIdentities],
      ['audit_log', schema.auditLog],
      ['breach_incidents', schema.breachIncidents],
      ['channel_rules', schema.channelRules],
      ['attribution_settings', schema.attributionSettings],
      ['capi_dispatch_log', schema.capiDispatchLog],
    ];

    for (const [name, table] of expected) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle's PgTable type isn't exported cleanly for a generic helper signature
      expect(getTableName(table as any)).toBe(name);
    }
  });

  it('gives every tenant-scoped table a store_id or organization_id column (ADR-0016)', () => {
    const tenantScoped: readonly object[] = [
      schema.stores,
      schema.dpaAcceptances,
      schema.integrations,
      schema.adAccounts,
      schema.orders,
      schema.consentRecords,
      schema.dsrRequests,
      schema.storeDeliveryRates,
      schema.suppressedIdentities,
      schema.auditLog,
      schema.channelRules,
      schema.attributionSettings,
      schema.capiDispatchLog,
    ];

    for (const table of tenantScoped) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      const columns = Object.keys(getTableColumns(table as any));
      expect(columns.some((c) => c === 'storeId' || c === 'organizationId')).toBe(true);
    }
  });

  it("never stores a shopper phone/email in the clear (SPEC §5.4) — Better Auth's own staff tables are exempt: users.email/invites.email are staff-account fields, and we are the Data Fiduciary for our own staff (SPEC §5.1), not the shopper-data processor path this rule targets", () => {
    const rawPiiPattern = /^(phone|email)$/i;
    const shopperDataTables: readonly object[] = [
      schema.orders,
      schema.consentRecords,
      schema.dsrRequests,
      schema.suppressedIdentities,
    ];
    for (const table of shopperDataTables) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      const columns = Object.keys(getTableColumns(table as any));
      for (const column of columns) {
        expect(rawPiiPattern.test(column)).toBe(false);
      }
    }
  });

  it('attaches a CHECK constraint to every text column backed by an @truepath/shared value list', () => {
    const expected: ReadonlyArray<readonly [object, string]> = [
      [schema.stores, 'stores_platform_check'],
      [schema.stores, 'stores_status_check'],
      [schema.organizations, 'organizations_status_check'],
      [schema.integrations, 'integrations_provider_check'],
      [schema.integrations, 'integrations_status_check'],
      [schema.adAccounts, 'ad_accounts_provider_check'],
      [schema.orders, 'orders_payment_method_check'],
      [schema.orders, 'orders_delivery_status_check'],
      [schema.orderStatusEvents, 'order_status_events_source_check'],
      [schema.storeDeliveryRates, 'store_delivery_rates_payment_method_check'],
      [schema.consentRecords, 'consent_records_source_check'],
      [schema.dsrRequests, 'dsr_requests_type_check'],
      [schema.dsrRequests, 'dsr_requests_status_check'],
      [schema.auditLog, 'audit_log_action_check'],
      [schema.channelRules, 'channel_rules_channel_check'],
      [schema.capiDispatchLog, 'capi_dispatch_log_event_name_check'],
      [schema.capiDispatchLog, 'capi_dispatch_log_status_check'],
    ];
    for (const [table, checkName] of expected) {
      expect(checkNames(table)).toContain(checkName);
    }
  });

  it("checks invites.status against Better Auth's own invitation value set, confirmed at M0-4 (auth-tenancy.md §3)", () => {
    expect(checkNames(schema.invites)).toEqual(['invites_status_check']);
  });

  it('has the idempotency unique constraints the LLDs rely on for upserts', () => {
    expect(uniqueNames(schema.orders)).toContain('orders_store_id_external_order_id_key');
    expect(uniqueNames(schema.integrations)).toContain(
      'integrations_store_id_provider_external_account_id_key',
    );
    expect(uniqueNames(schema.adAccounts)).toContain(
      'ad_accounts_store_id_provider_external_id_key',
    );
    expect(uniqueNames(schema.capiDispatchLog)).toContain(
      'capi_dispatch_log_store_id_event_id_key',
    );
    expect(uniqueNames(schema.storeDeliveryRates)).toContain(
      'store_delivery_rates_store_id_payment_method_key',
    );
    expect(uniqueNames(schema.suppressedIdentities)).toContain('suppressed_identities_unique');
    expect(uniqueNames(schema.authAccounts)).toContain('auth_accounts_provider_id_account_id_key');
    // capi_dispatch_log must NOT have a bare global-unique on event_id any more (superseded by the
    // tenant-scoped composite above).
    expect(uniqueNames(schema.capiDispatchLog)).not.toContain('capi_dispatch_log_event_id_key');
  });

  it('audit_log.organization_id has no FK (audit history stays attributable after the org is deleted)', () => {
    const config = getTableConfig(schema.auditLog);
    const fk = config.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === 'organization_id'),
    );
    expect(fk).toBeUndefined();
    expect(config.indexes.map((i) => i.config.name)).toContain('audit_log_organization_id_idx');
  });

  it('memberships and invites store role as the code-controlled role enum, not a free-form CHECK (auth-tenancy.md §2.4)', () => {
    expect(
      getTableConfig(schema.memberships).columns.find((c) => c.name === 'role')?.enumValues,
    ).toEqual(['owner', 'admin', 'analyst', 'viewer']);
    expect(
      getTableConfig(schema.invites).columns.find((c) => c.name === 'role')?.enumValues,
    ).toEqual(['owner', 'admin', 'analyst', 'viewer']);
  });

  it('memberships has the (organization_id, user_id) index the scope-building lookup relies on (auth-tenancy.md §4.3/§7)', () => {
    const config = getTableConfig(schema.memberships);
    expect(config.indexes.map((i) => i.config.name)).toContain(
      'memberships_organization_id_user_id_idx',
    );
  });

  it('audit_log.actor_user_id has no FK (audit history stays attributable after the user is deleted, and user/org deletion is never blocked by audit rows)', () => {
    const config = getTableConfig(schema.auditLog);
    const fk = config.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === 'actor_user_id'),
    );
    expect(fk).toBeUndefined();
    expect(config.indexes.map((i) => i.config.name)).toContain('audit_log_actor_user_id_idx');
  });
});
