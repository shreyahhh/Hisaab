import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { assertOrganizationInScope, assertStoreInScope, type Scope } from '@truepath/shared';
import type { CredentialsCipher } from '@truepath/privacy';
import type { Db } from '../client.js';
import { integrations, stores } from '../schema/index.js';

export type IntegrationRow = typeof integrations.$inferSelect;

export interface UpsertShopifyIntegrationInput {
  readonly storeId: string;
  readonly externalAccountId: string; // shop GID (shopify-integration.md §2.7 shopInfo)
  /** Plaintext, JSON-serialised `ShopifyCredentials` — encrypted here, never by the caller (ADR-0023):
   * the envelope's AAD must bind the row's *actual* id, which this method alone resolves atomically. */
  readonly credentialsJson: string;
  readonly scopes: readonly string[];
  readonly cipher: CredentialsCipher;
}

export interface IntegrationRepository {
  /** Creates the store's Shopify integration on first connect, or updates it on re-auth. */
  upsertShopify(scope: Scope, input: UpsertShopifyIntegrationInput): Promise<IntegrationRow>;
  /**
   * Looks the integration up *within* `organizationId`'s scope (ADR-0024): a foreign integration id
   * under the caller's own org, and a nonexistent id, both come back `null` — the same shape, by
   * design (SPEC §5.10 test 7).
   */
  getByIdForOrganization(
    scope: Scope,
    organizationId: string,
    integrationId: string,
  ): Promise<IntegrationRow | null>;
  /** `DELETE /v1/orgs/:id/integrations/:integrationId`: marks it revoked and wipes credentials. */
  revokeForOrganization(
    scope: Scope,
    organizationId: string,
    integrationId: string,
  ): Promise<IntegrationRow | null>;
  /** `app/uninstalled` webhook (store-scoped — the caller has no organization id yet). */
  markUninstalled(scope: Scope, storeId: string): Promise<IntegrationRow | null>;
  /** `GET /v1/stores/:id/integrations` (SPEC §10, dashboard.md §2.1): every integration for a store, any status. */
  listByStore(scope: Scope, storeId: string): Promise<IntegrationRow[]>;
}

/** The only sanctioned way to read/write `integrations` (ADR-0016) — every method requires a Scope. */
export function createIntegrationRepository(db: Db): IntegrationRepository {
  async function getByIdForOrganization(
    scope: Scope,
    organizationId: string,
    integrationId: string,
  ) {
    assertOrganizationInScope(scope, organizationId);
    const rows = await db
      .select({ integration: integrations })
      .from(integrations)
      .innerJoin(stores, eq(stores.id, integrations.storeId))
      .where(and(eq(integrations.id, integrationId), eq(stores.organizationId, organizationId)))
      .limit(1);
    return rows[0]?.integration ?? null;
  }

  return {
    getByIdForOrganization,

    async upsertShopify(scope, input) {
      assertStoreInScope(scope, input.storeId);
      return db.transaction(async (tx) => {
        // Serialises concurrent connect/re-auth attempts for the same store (shopify-integration.md
        // §4.1 step 3 uses the same advisory-lock pattern for token refresh). Without it, two
        // concurrent callbacks could both resolve "no existing row", pick different candidate ids,
        // and encrypt against a candidate that Postgres's ON CONFLICT then discards — corrupting the
        // AAD binding for whichever one loses the race.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`shopify-connect:${input.storeId}`}))`,
        );

        const existingRows = await tx
          .select({ id: integrations.id })
          .from(integrations)
          .where(and(eq(integrations.storeId, input.storeId), eq(integrations.provider, 'shopify')))
          .limit(1);
        // Reuse the existing row's id so its envelope's AAD stays valid; a brand-new row gets an id
        // generated here (not left to the column default) for the same reason — the AAD must be
        // computed against the id the row will actually have, before the row is written.
        const id = existingRows[0]?.id ?? randomUUID();
        const encryptedCredentials = input.cipher.encrypt(
          { integrationId: id },
          input.credentialsJson,
        );

        const [row] = await tx
          .insert(integrations)
          .values({
            id,
            storeId: input.storeId,
            provider: 'shopify',
            externalAccountId: input.externalAccountId,
            encryptedCredentials,
            scopes: [...input.scopes],
            status: 'active',
            lastSyncedAt: new Date(),
            error: null,
          })
          .onConflictDoUpdate({
            target: [integrations.storeId, integrations.provider, integrations.externalAccountId],
            set: {
              encryptedCredentials,
              scopes: [...input.scopes],
              status: 'active',
              lastSyncedAt: new Date(),
              error: null,
            },
          })
          .returning();
        if (!row) throw new Error('upsertShopify: insert/update did not return a row');
        return row;
      });
    },

    async revokeForOrganization(scope, organizationId, integrationId) {
      const existing = await getByIdForOrganization(scope, organizationId, integrationId);
      if (!existing) return null;
      const [row] = await db
        .update(integrations)
        .set({ status: 'revoked', encryptedCredentials: null })
        .where(eq(integrations.id, existing.id))
        .returning();
      return row ?? null;
    },

    async markUninstalled(scope, storeId) {
      assertStoreInScope(scope, storeId);
      const [row] = await db
        .update(integrations)
        .set({ status: 'revoked', encryptedCredentials: null })
        .where(and(eq(integrations.storeId, storeId), eq(integrations.provider, 'shopify')))
        .returning();
      return row ?? null;
    },

    async listByStore(scope, storeId) {
      assertStoreInScope(scope, storeId);
      return db.select().from(integrations).where(eq(integrations.storeId, storeId));
    },
  };
}
