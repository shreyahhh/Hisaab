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

/**
 * `integrations.settings.backfill` (shopify-integration.md §2.7 — non-secret only). Every field is
 * optional so each step of the backfill lifecycle patches only what it knows; the stored object is
 * the merge of all patches.
 */
export interface BackfillStatePatch {
  readonly days?: number;
  readonly status?: 'running' | 'done' | 'failed';
  readonly bulk_operation_id?: string;
  readonly started_at?: string;
  readonly finished_at?: string;
  readonly orders_applied?: number;
  /** What Shopify's own `rootObjectCount` said the result held, to reconcile against `orders_applied`. */
  readonly orders_reported?: number;
  /** A count only — never the rejected line, which can hold protected customer data. */
  readonly invalid_lines?: number;
  /** A short machine code (e.g. a Shopify `errorCode`), never a message that could embed data. */
  readonly error_code?: string;
}

/**
 * Top-level, non-secret keys of `integrations.settings` for a Shopify integration (shopify-
 * integration.md §2.7). `store_key` is public by design (it is in the pixel's settings); the pixel
 * signing *secret* is never here — it lives in `encrypted_credentials`.
 */
export interface ShopifySettingsPatch {
  readonly store_key?: string;
  readonly pixel_id?: string;
  readonly pixel_status?: 'installed' | 'failed' | 'not_configured';
  /** Shopify userError codes only (e.g. INVALID_SETTINGS), comma-joined — never a message. */
  readonly pixel_error_codes?: string;
}

export interface UpsertMetaIntegrationInput {
  readonly storeId: string;
  readonly externalAccountId: string; // Meta's own id for the *business* the token is issued to
  /** Plaintext, JSON-serialised `MetaCredentials` — encrypted here, never by the caller (ADR-0023, mirrors `upsertShopify`). */
  readonly credentialsJson: string;
  readonly scopes: readonly string[];
  readonly cipher: CredentialsCipher;
}

/**
 * `integrations.settings` for a Meta integration (meta-integration.md §3; M1-8 only writes
 * `ad_account_ids` and `warmup` — `capi`/`insights` land with M2/M4).
 */
export interface MetaSettingsPatch {
  readonly ad_account_ids?: readonly string[];
}

/**
 * `integrations.settings.warmup` (M1-8, meta-integration.md §2.2 `meta-warmup`): the running ledger
 * behind the ≥ 1,500-calls / < 15%-errors Advanced Access requirement. Every field is optional so each
 * run patches only what it knows; the stored object is the merge of all patches (mirrors
 * `patchShopifyBackfillState`'s shape, not its lifecycle — there is no terminal state here, it runs
 * indefinitely until App Review passes).
 */
export interface MetaWarmupStatePatch {
  readonly calls_total?: number;
  readonly calls_success?: number;
  readonly calls_error?: number;
  readonly last_run_at?: string;
  /** A Graph API error code/subcode only — never a message, which can echo request data. */
  readonly last_error_code?: string;
}

export interface IntegrationRepository {
  /** Creates the store's Shopify integration on first connect, or updates it on re-auth. */
  upsertShopify(scope: Scope, input: UpsertShopifyIntegrationInput): Promise<IntegrationRow>;
  /** Creates or updates the store's Meta integration (M1-8: registered by the operator CLI, not OAuth yet). */
  upsertMeta(scope: Scope, input: UpsertMetaIntegrationInput): Promise<IntegrationRow>;
  /** Merges `patch` into the store's Meta `settings` (top-level keys only, atomically). No-op without an active Meta integration. */
  patchMetaSettings(
    scope: Scope,
    storeId: string,
    patch: MetaSettingsPatch,
  ): Promise<IntegrationRow | null>;
  /** Merges `patch` into the store's Meta `settings.warmup` ledger, creating it if absent. No-op without an active Meta integration. */
  patchMetaWarmupState(
    scope: Scope,
    storeId: string,
    patch: MetaWarmupStatePatch,
  ): Promise<IntegrationRow | null>;
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
  /** The store's active integration for a provider (job-scope-friendly — no organization id needed). */
  getActiveByStore(scope: Scope, storeId: string, provider: string): Promise<IntegrationRow | null>;
  /** Every integration row (any provider, any status) for the store — the dashboard's Integrations page. */
  listByStore(scope: Scope, storeId: string): Promise<IntegrationRow[]>;
  /**
   * Merges `patch` into the store's Shopify `settings.backfill` (creating it if absent) in one
   * atomic UPDATE, so two writers patching different fields never lose each other's keys. Stamps
   * `last_synced_at` when the patch marks the backfill `done`. No-op (null) if the store has no
   * active Shopify integration.
   */
  patchShopifyBackfillState(
    scope: Scope,
    storeId: string,
    patch: BackfillStatePatch,
  ): Promise<IntegrationRow | null>;
  /**
   * Merges `patch` into the store's Shopify `settings` (top-level keys only, atomically), leaving
   * every other key — `backfill`, `cod_mapping`, … — untouched. No-op (null) without an active
   * Shopify integration.
   */
  patchShopifySettings(
    scope: Scope,
    storeId: string,
    patch: ShopifySettingsPatch,
  ): Promise<IntegrationRow | null>;
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
        // Serialises concurrent writers for the same store's Shopify integration row — connect,
        // re-auth, and (M1-2) a token refresh triggered by an order-hint webhook all go through this
        // same method. Without it, two concurrent writers could both resolve "no existing row" (or
        // both read the same pre-refresh id), pick different candidate ids, and encrypt against a
        // candidate that Postgres's ON CONFLICT then discards — corrupting the AAD binding for
        // whichever one loses the race.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`shopify-integration:${input.storeId}`}))`,
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

    async upsertMeta(scope, input) {
      assertStoreInScope(scope, input.storeId);
      return db.transaction(async (tx) => {
        // Same race the Shopify method guards against (concurrent connect/re-auth for one store) — see
        // its comment. M1-8 has only one writer (the operator CLI), but the lock costs nothing and
        // keeps the two methods' safety properties identical.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`meta-integration:${input.storeId}`}))`,
        );

        const existingRows = await tx
          .select({ id: integrations.id })
          .from(integrations)
          .where(and(eq(integrations.storeId, input.storeId), eq(integrations.provider, 'meta')))
          .limit(1);
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
            provider: 'meta',
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
        if (!row) throw new Error('upsertMeta: insert/update did not return a row');
        return row;
      });
    },

    async patchMetaSettings(scope, storeId, patch) {
      assertStoreInScope(scope, storeId);
      const [row] = await db
        .update(integrations)
        .set({
          settings: sql`coalesce(${integrations.settings}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
        })
        .where(
          and(
            eq(integrations.storeId, storeId),
            eq(integrations.provider, 'meta'),
            eq(integrations.status, 'active'),
          ),
        )
        .returning();
      return row ?? null;
    },

    async patchMetaWarmupState(scope, storeId, patch) {
      assertStoreInScope(scope, storeId);
      const patchJson = JSON.stringify(patch);
      const [row] = await db
        .update(integrations)
        .set({
          settings: sql`jsonb_set(
            coalesce(${integrations.settings}, '{}'::jsonb),
            '{warmup}',
            coalesce(${integrations.settings} -> 'warmup', '{}'::jsonb) || ${patchJson}::jsonb
          )`,
        })
        .where(
          and(
            eq(integrations.storeId, storeId),
            eq(integrations.provider, 'meta'),
            eq(integrations.status, 'active'),
          ),
        )
        .returning();
      return row ?? null;
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

    async getActiveByStore(scope, storeId, provider) {
      assertStoreInScope(scope, storeId);
      const rows = await db
        .select()
        .from(integrations)
        .where(
          and(
            eq(integrations.storeId, storeId),
            eq(integrations.provider, provider),
            eq(integrations.status, 'active'),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async listByStore(scope, storeId) {
      assertStoreInScope(scope, storeId);
      return db.select().from(integrations).where(eq(integrations.storeId, storeId));
    },

    async patchShopifySettings(scope, storeId, patch) {
      assertStoreInScope(scope, storeId);
      const [row] = await db
        .update(integrations)
        .set({
          settings: sql`coalesce(${integrations.settings}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
        })
        .where(
          and(
            eq(integrations.storeId, storeId),
            eq(integrations.provider, 'shopify'),
            eq(integrations.status, 'active'),
          ),
        )
        .returning();
      return row ?? null;
    },

    async patchShopifyBackfillState(scope, storeId, patch) {
      assertStoreInScope(scope, storeId);
      const patchJson = JSON.stringify(patch);
      const [row] = await db
        .update(integrations)
        .set({
          settings: sql`jsonb_set(
            coalesce(${integrations.settings}, '{}'::jsonb),
            '{backfill}',
            coalesce(${integrations.settings} -> 'backfill', '{}'::jsonb) || ${patchJson}::jsonb
          )`,
          // The JS clock, like `upsertShopify`'s own stamp: mixing it with the database's `now()` in one
          // column made the ordering depend on clock skew between the two hosts.
          ...(patch.status === 'done' ? { lastSyncedAt: new Date() } : {}),
        })
        .where(
          and(
            eq(integrations.storeId, storeId),
            eq(integrations.provider, 'shopify'),
            eq(integrations.status, 'active'),
          ),
        )
        .returning();
      return row ?? null;
    },
  };
}
