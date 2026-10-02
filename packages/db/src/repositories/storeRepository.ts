import { and, eq, ne } from 'drizzle-orm';
import { assertOrganizationInScope, assertStoreInScope, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { stores } from '../schema/index.js';

export type StoreRow = typeof stores.$inferSelect;

export interface UpsertStoreByShopDomainInput {
  readonly organizationId: string;
  readonly shopDomain: string;
  readonly currency?: string;
}

/**
 * Thrown when `shopDomain` already belongs to a different organization (shopify-integration.md
 * §4.1 step 4: "A shop linked to another org → `409 shop_linked_elsewhere`"). Never carries the
 * other organization's id — routes turn this into a bare 409, not a resource-existence disclosure.
 */
export class ShopLinkedToAnotherOrganizationError extends Error {
  constructor(shopDomain: string) {
    super(`${shopDomain} is already connected to another organization`);
    this.name = 'ShopLinkedToAnotherOrganizationError';
  }
}

export interface ConfirmIndiaOptInResult {
  readonly store: StoreRow;
  /** False the first time a store confirms; true on a repeat (no write happened). */
  readonly alreadyConfirmed: boolean;
}

/** HLD §8 "Consent-region gate" layer 2 (event-pipeline.md §4.4, issue #52). */
export interface ConsentHealthInput {
  readonly status: 'ok' | 'warn' | 'paused';
  readonly ratio: number;
  readonly measuredAt: Date;
  /** Only meaningful (and set) when `status === 'paused'`. */
  readonly pausedAt?: Date;
}

export interface StoreRepository {
  listByOrganization(scope: Scope, organizationId: string): Promise<StoreRow[]>;
  getById(scope: Scope, storeId: string): Promise<StoreRow | null>;
  /**
   * Creates the store on first connect, or reactivates it on a re-auth for the same org
   * (shopify-integration.md §4.1 step 4). Throws {@link ShopLinkedToAnotherOrganizationError} if the
   * shop domain is already owned by a different organization.
   */
  upsertByShopDomain(scope: Scope, input: UpsertStoreByShopDomainInput): Promise<StoreRow>;
  /** `app/uninstalled` webhook (shopify-integration.md §4.8). Idempotent: returns null if already uninstalled. */
  markUninstalled(scope: Scope, storeId: string): Promise<StoreRow | null>;
  /**
   * Sets `privacy_config.checklist.india_opt_in_confirmed_at` (HLD §8 "Consent-region gate" layer 1;
   * SPEC P-1; issue #72) — the merchant's onboarding confirmation that their consent banner treats
   * India as opt-in. Merges into the existing `privacy_config` object rather than replacing it (one
   * home per setting: `notice_version`, `grievance_contact` and `consent_health` are left untouched).
   * Idempotent: a repeat confirmation is a no-op that returns the existing timestamp.
   */
  confirmIndiaOptIn(scope: Scope, storeId: string): Promise<ConfirmIndiaOptInResult | null>;
  /**
   * Sets `privacy_config.consent_health` (HLD §8 "Consent-region gate" layer 2, issue #52) — the
   * default-on-region evaluator's latest reading. Replaces the whole `consent_health` object (it's
   * always one evaluation's complete result, never partial fields to merge), merging only into the
   * surrounding `privacy_config` (one home per setting: `notice_version`, `grievance_contact` and
   * `checklist` are left untouched). Returns null if the store doesn't exist.
   */
  updateConsentHealth(
    scope: Scope,
    storeId: string,
    input: ConsentHealthInput,
  ): Promise<StoreRow | null>;
  /**
   * Issue #25 (privacy-dpdp.md §4.7 step 3): the final step of `store_erasure` — `status='deleted'`
   * and `privacy_config` nulled back to `{}` (it can carry a grievance contact name/email/phone).
   * The row itself, `audit_log` and `dsr_requests` are kept as the tombstone + record; they hold no
   * shopper data. Idempotent: returns null if already deleted.
   */
  markDeleted(scope: Scope, storeId: string): Promise<StoreRow | null>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The only sanctioned way to read/write `stores` (ADR-0016) — every method requires a Scope. */
export function createStoreRepository(db: Db): StoreRepository {
  return {
    async listByOrganization(scope, organizationId) {
      assertOrganizationInScope(scope, organizationId);
      return db.select().from(stores).where(eq(stores.organizationId, organizationId));
    },
    async getById(scope, storeId) {
      assertStoreInScope(scope, storeId);
      const rows = await db.select().from(stores).where(eq(stores.id, storeId)).limit(1);
      return rows[0] ?? null;
    },
    async upsertByShopDomain(scope, input) {
      assertOrganizationInScope(scope, input.organizationId);
      return db.transaction(async (tx) => {
        const existingRows = await tx
          .select()
          .from(stores)
          .where(eq(stores.shopDomain, input.shopDomain))
          .limit(1);
        const existing = existingRows[0];

        if (existing) {
          if (existing.organizationId !== input.organizationId) {
            throw new ShopLinkedToAnotherOrganizationError(input.shopDomain);
          }
          const [updated] = await tx
            .update(stores)
            .set({
              status: 'active',
              currency: input.currency ?? existing.currency,
              installedAt: existing.installedAt ?? new Date(),
            })
            .where(eq(stores.id, existing.id))
            .returning();
          if (!updated) throw new Error('upsertByShopDomain: update did not return a row');
          return updated;
        }

        const [inserted] = await tx
          .insert(stores)
          .values({
            organizationId: input.organizationId,
            shopDomain: input.shopDomain,
            currency: input.currency ?? 'INR',
            installedAt: new Date(),
            status: 'active',
          })
          .returning();
        if (!inserted) throw new Error('upsertByShopDomain: insert did not return a row');
        return inserted;
      });
    },
    async markUninstalled(scope, storeId) {
      assertStoreInScope(scope, storeId);
      // The `status != 'uninstalled'` guard makes a retried webhook a genuine no-op (returns null)
      // rather than re-writing an already-uninstalled row — Shopify retries this webhook up to 8x/4h.
      const rows = await db
        .update(stores)
        .set({ status: 'uninstalled' })
        .where(and(eq(stores.id, storeId), ne(stores.status, 'uninstalled')))
        .returning();
      return rows[0] ?? null;
    },
    async confirmIndiaOptIn(scope, storeId) {
      assertStoreInScope(scope, storeId);
      return db.transaction(async (tx) => {
        const rows = await tx.select().from(stores).where(eq(stores.id, storeId)).limit(1);
        const existing = rows[0];
        if (!existing) return null;

        const config = asRecord(existing.privacyConfig);
        const checklist = asRecord(config['checklist']);
        const already = checklist['india_opt_in_confirmed_at'];
        if (typeof already === 'string' && already !== '') {
          return { store: existing, alreadyConfirmed: true };
        }

        const [updated] = await tx
          .update(stores)
          .set({
            privacyConfig: {
              ...config,
              checklist: { ...checklist, india_opt_in_confirmed_at: new Date().toISOString() },
            },
          })
          .where(eq(stores.id, storeId))
          .returning();
        if (!updated) throw new Error('confirmIndiaOptIn: update did not return a row');
        return { store: updated, alreadyConfirmed: false };
      });
    },
    async updateConsentHealth(scope, storeId, input) {
      assertStoreInScope(scope, storeId);
      const rows = await db.select().from(stores).where(eq(stores.id, storeId)).limit(1);
      const existing = rows[0];
      if (!existing) return null;

      const config = asRecord(existing.privacyConfig);
      const consentHealth: Record<string, unknown> = {
        status: input.status,
        ratio: input.ratio,
        measured_at: input.measuredAt.toISOString(),
      };
      if (input.pausedAt) consentHealth['paused_at'] = input.pausedAt.toISOString();

      const [updated] = await db
        .update(stores)
        .set({ privacyConfig: { ...config, consent_health: consentHealth } })
        .where(eq(stores.id, storeId))
        .returning();
      if (!updated) throw new Error('updateConsentHealth: update did not return a row');
      return updated;
    },
    async markDeleted(scope, storeId) {
      assertStoreInScope(scope, storeId);
      const rows = await db
        .update(stores)
        .set({ status: 'deleted', privacyConfig: {} })
        .where(and(eq(stores.id, storeId), ne(stores.status, 'deleted')))
        .returning();
      return rows[0] ?? null;
    },
  };
}
