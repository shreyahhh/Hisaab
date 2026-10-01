import type { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import {
  createAuditLogRepository,
  createConsentRecordRepository,
  createDsrRequestRepository,
  createStoreRepository,
  createSuppressedIdentityRepository,
} from '@truepath/db';
import { storeContext, type CredentialsCipher, type IdentityHasher } from '@truepath/privacy';
import { DSR_JOB_OPTIONS, type DsrJob } from '@truepath/shared';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { publishCollectorConfig } from '../shopifyPixel.js';
import { requirePermission, requireStoreScope, type TenantScopeDeps } from '../tenantScope.js';

export interface PrivacyDashboardRouteOptions {
  readonly dpaVersion: string;
  /** ADR-0023 envelope encryption — needed to read a store's pixel signing keys back out. */
  readonly cipher: CredentialsCipher;
  /** Durable Redis — where `collector:store:<store_key>` configs live. */
  readonly redis: Redis;
  /** Hashes the phone/email a merchant submits on `POST .../privacy/requests` (issue #92). */
  readonly hasher: IdentityHasher;
  /** HLD §8 `dsr` queue — a merchant-created `erasure`/`correction` request is enqueued immediately. */
  readonly dsrQueue: Pick<Queue<DsrJob>, 'add'>;
}

// privacy-dpdp.md §4.3 step 1 / §4.6 step 1: the merchant-initiated DSR request body (SPEC §10).
// `access` validates but is rejected with a clear error before any row is written — its fulfilment
// needs an S3 export bucket this phase doesn't provision (issue #91) — rather than creating a request
// that would sit `pending` forever with nothing to process it.
const PrivacyRequestBody = z
  .object({
    type: z.enum(['access', 'erasure', 'correction']),
    phone: z.string().min(1).max(32).optional(),
    email: z.string().min(1).max(320).optional(),
  })
  .strict()
  .refine((b) => (b.phone !== undefined) !== (b.email !== undefined), {
    message: 'exactly one of phone or email is required',
  });

/** SPEC §5.7: every DSR request's due_at is 7 days out, merchant- or webhook-initiated alike. */
const DSR_SLA_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `GET /v1/stores/:id/privacy/consent-stats` and `GET /v1/stores/:id/privacy/requests` (SPEC §10).
 * Consent records store only an HMAC'd visitor id (SPEC v0.2 §6.1) and DSR rows carry a hashed
 * identity, never raw phone/email — nothing here needs additional redaction before it's returned.
 */
export function registerPrivacyDashboardRoutes(
  app: FastifyInstance,
  deps: TenantScopeDeps,
  options: PrivacyDashboardRouteOptions,
): void {
  app.get<{ Params: { storeId: string } }>(
    '/v1/stores/:storeId/privacy/consent-stats',
    { preHandler: [requireStoreScope(deps), requirePermission('privacy.requests')] },
    async (request, reply) => {
      const scope = request.scope!;
      const storeId = request.params.storeId;
      const [consentRecords, suppressedCount] = await Promise.all([
        createConsentRecordRepository(deps.db).listRecentByStore(scope, storeId, 20),
        createSuppressedIdentityRepository(deps.db).countByStore(scope, storeId),
      ]);
      await reply.send({
        suppressed_identities_count: suppressedCount,
        consent_records_recent: consentRecords.map((row) => ({
          state: row.state,
          purposes: row.purposes,
          source: row.source,
          notice_version: row.noticeVersion,
          occurred_at: row.occurredAt.toISOString(),
        })),
      });
    },
  );

  app.get<{ Params: { storeId: string } }>(
    '/v1/stores/:storeId/privacy/requests',
    { preHandler: [requireStoreScope(deps), requirePermission('privacy.requests')] },
    async (request, reply) => {
      const scope = request.scope!;
      const rows = await createDsrRequestRepository(deps.db).listRecentByStore(
        scope,
        request.params.storeId,
        20,
      );
      await reply.send({
        requests: rows.map((row) => ({
          id: row.id,
          type: row.type,
          status: row.status,
          created_at: row.createdAt.toISOString(),
          due_at: row.dueAt.toISOString(),
          completed_at: row.completedAt ? row.completedAt.toISOString() : null,
          trigger:
            row.resultSummary && typeof row.resultSummary === 'object'
              ? ((row.resultSummary as Record<string, unknown>)['trigger'] ?? null)
              : null,
        })),
        // M4-2 fulfils these rows (export/erasure); until then every request just sits `pending`.
        note: 'Processing (export/erasure) arrives in M4 — requests are recorded but not yet fulfilled.',
      });
    },
  );

  /**
   * `POST /v1/stores/:id/privacy/requests` (SPEC §10, issue #92): the merchant enters a shopper's
   * phone or email; it's hashed immediately (the raw value is never stored) and matched against
   * ClickHouse/Postgres by `resolveErasureScope`'s one-hop expansion when the job runs, not here.
   * `erasure` and `correction` are enqueued right away; `access` is rejected before any row is
   * written (issue #91 — no S3 export bucket yet to fulfil it against).
   */
  app.post<{ Params: { storeId: string }; Body: unknown }>(
    '/v1/stores/:storeId/privacy/requests',
    { preHandler: [requireStoreScope(deps), requirePermission('privacy.requests')] },
    async (request, reply) => {
      const scope = request.scope!;
      const storeId = request.params.storeId;

      const body = PrivacyRequestBody.safeParse(request.body);
      if (!body.success) {
        await reply.code(400).send({ error: 'invalid_body', fields: ['type', 'phone', 'email'] });
        return;
      }
      const { type } = body.data;

      if (type === 'access') {
        await reply.code(409).send({
          error: 'access_not_available',
          detail:
            'DSR access export needs an export store this environment does not provision yet.',
        });
        return;
      }

      const context = storeContext(storeId);
      const identityHash =
        body.data.phone !== undefined
          ? options.hasher.hashPhone(context, body.data.phone)
          : options.hasher.hashEmail(context, body.data.email!);
      if (identityHash === null) {
        await reply.code(400).send({ error: 'invalid_identifier' });
        return;
      }

      const row = await createDsrRequestRepository(deps.db).createFromMerchant(scope, {
        storeId,
        type,
        identityHash,
        dueAt: new Date(Date.now() + DSR_SLA_MS),
      });
      await createAuditLogRepository(deps.db).write(scope, {
        organizationId: scope.organizationId,
        actorUserId: scope.userId,
        actorType: 'user',
        action: 'dsr_created',
        targetType: 'dsr_request',
        targetId: row.id,
        metadata: { type, trigger: 'merchant' },
      });
      await options.dsrQueue.add(
        type,
        { storeId, type, requestId: row.id },
        { jobId: `dsr-${row.id}`, ...DSR_JOB_OPTIONS },
      );

      await reply.code(201).send({
        id: row.id,
        type: row.type,
        status: row.status,
        due_at: row.dueAt.toISOString(),
      });
    },
  );

  /**
   * `POST /v1/stores/:id/privacy/confirm-india-opt-in` (HLD §8 "Consent-region gate" layer 1; SPEC
   * P-1; issue #72). Owner/admin only (`privacy.settings.write`). The merchant's one-time confirmation
   * that their Shopify consent banner (or consent app) treats India as an opt-in region — the second
   * of the two hard gates (with the DPA) that `publishCollectorConfig` requires before the Collector
   * accepts any event for this store (packages/db/src/collectorConfig.ts). Onboarding must point the
   * merchant at `docs/dpdp/README.md` before they confirm this.
   *
   * Idempotent: a repeat confirmation is `200` with the existing timestamp and writes no second audit
   * row, matching `POST /v1/orgs/:id/dpa/accept`'s repeat behaviour. Republishes the collector config
   * synchronously after a real (non-repeat) confirmation, same pattern as the DPA route (issue #22) —
   * best-effort: a Redis error is logged (ids only) and does not fail the response.
   */
  app.post<{ Params: { storeId: string } }>(
    '/v1/stores/:storeId/privacy/confirm-india-opt-in',
    { preHandler: [requireStoreScope(deps), requirePermission('privacy.settings.write')] },
    async (request, reply) => {
      const scope = request.scope!;
      const storeId = request.params.storeId;

      const result = await createStoreRepository(deps.db).confirmIndiaOptIn(scope, storeId);
      if (!result) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }

      if (!result.alreadyConfirmed) {
        await createAuditLogRepository(deps.db).write(scope, {
          organizationId: scope.organizationId,
          actorUserId: scope.userId,
          actorType: 'user',
          action: 'consent_region_confirmed',
          targetType: 'store',
          targetId: storeId,
        });

        try {
          await publishCollectorConfig(
            {
              db: deps.db,
              cipher: options.cipher,
              redis: options.redis,
              dpaVersion: options.dpaVersion,
            },
            scope,
            storeId,
          );
        } catch (error) {
          console.error(
            JSON.stringify({
              event: 'collector_config_republish_failed',
              store_id: storeId,
              error_name: error instanceof Error ? error.name : 'unknown',
            }),
          );
        }
      }

      const config =
        typeof result.store.privacyConfig === 'object' &&
        result.store.privacyConfig !== null &&
        !Array.isArray(result.store.privacyConfig)
          ? (result.store.privacyConfig as Record<string, unknown>)
          : {};
      const checklist =
        typeof config['checklist'] === 'object' &&
        config['checklist'] !== null &&
        !Array.isArray(config['checklist'])
          ? (config['checklist'] as Record<string, unknown>)
          : {};
      await reply.code(result.alreadyConfirmed ? 200 : 201).send({
        india_opt_in_confirmed_at: checklist['india_opt_in_confirmed_at'],
      });
    },
  );
}
