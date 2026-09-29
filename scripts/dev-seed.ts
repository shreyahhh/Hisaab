/* eslint-disable no-console */
// Dev-only seed script (not part of the app): creates one real tenant end-to-end — signup, org, DPA
// acceptance, India opt-in confirmation, a Shopify "connection" (a real `stores`/`integrations` row,
// since a live OAuth install needs a public tunnel and an approved Partner app — BLOCKERS.md #1/#2)
// — then sends a few real, signed pixel batches through the actually-running Collector so the
// dashboard has real events/touchpoints/consent records to show, and seeds a couple of orders
// directly via `orderRepository` (exactly what the order webhook handler itself calls).
//
// Requires: Docker Compose up, migrations run, and `pnpm --filter @truepath/collector dev` +
// `pnpm --filter @truepath/workers dev` both running (the pixel step needs the Collector listening;
// the events/consent-records step additionally needs `event-workers` to consume the stream — if
// either isn't reachable, this script says so and skips just that step rather than failing).
//
// Run: pnpm dev:seed

import { randomBytes, createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { createAuth } from '@truepath/auth';
import {
  createDb,
  createIntegrationRepository,
  createOrderRepository,
  createStoreRepository,
  publishCollectorConfig,
  schema,
} from '@truepath/db';
import { createCredentialsCipher, createIdentityHasher, hashContact } from '@truepath/privacy';
import {
  authEnvSchema,
  clickhouseEnvSchema,
  collectSigningInput,
  credentialsKeyEnvSchema,
  dpaEnvSchema,
  identityKeyEnvSchema,
  loadDotEnvIfPresent,
  loadEnv,
  postgresEnvSchema,
  redisDurableEnvSchema,
  SHOPIFY_OAUTH_SCOPES,
  uuidV7,
  type TenantScope,
} from '@truepath/shared';

loadDotEnvIfPresent('.env');
const env = loadEnv(
  postgresEnvSchema
    .and(clickhouseEnvSchema)
    .and(redisDurableEnvSchema)
    .and(identityKeyEnvSchema)
    .and(credentialsKeyEnvSchema)
    .and(dpaEnvSchema)
    .and(authEnvSchema),
);

const COLLECTOR_URL = process.env.COLLECTOR_URL ?? 'http://localhost:3001';
const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const DEMO_EMAIL = 'demo@truepath.local';
const DEMO_PASSWORD = 'demo-password-not-secret-123';

function scopeFor(organizationId: string, storeId?: string): TenantScope {
  return {
    kind: 'tenant',
    userId: null,
    organizationId,
    role: 'job',
    storeIds: new Set(storeId ? [storeId] : []),
  };
}

async function main(): Promise<void> {
  const db = createDb(env.DATABASE_URL);
  const cipher = createCredentialsCipher(env.credentialsKeys);
  const hasher = createIdentityHasher(env.identityKeys);
  const redis = new Redis(env.REDIS_DURABLE_URL);
  const auth = createAuth({
    db,
    env: {
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: env.BETTER_AUTH_URL,
      DASHBOARD_URL: env.DASHBOARD_URL,
      GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    },
    redisDurableUrl: env.REDIS_DURABLE_URL,
    allowInsecureCookies: true,
  });

  console.log('1/8 signing up the demo user (or reusing it if it already exists)...');
  // Ignore the result: on a re-run the account already exists and this just fails harmlessly — the
  // sign-in below is what actually matters, and it works either way.
  await auth.api.signUpEmail({
    body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: 'Demo Owner' },
    asResponse: true,
  });
  // SES isn't wired (M4+), so no real user is ever auto-verified — set it directly, same as the
  // test suite's own `seedRealTenant` helper does.
  await db
    .update(schema.users)
    .set({ emailVerified: true })
    .where(eq(schema.users.email, DEMO_EMAIL));
  const signIn = await auth.api.signInEmail({
    body: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    asResponse: true,
  });
  const cookie = signIn.headers.get('set-cookie');
  if (!cookie) throw new Error('sign-in did not return a session cookie');
  const [demoUser] = await db.select().from(schema.users).where(eq(schema.users.email, DEMO_EMAIL));
  if (!demoUser) throw new Error('demo user not found after sign-in');

  console.log('2/8 finding or creating the demo organization...');
  const orgs = await auth.api.listOrganizations({ headers: new Headers({ cookie }) });
  let organizationId = orgs?.[0]?.id;
  if (!organizationId) {
    const org = await auth.api.createOrganization({
      body: { name: 'Demo Brand', slug: `demo-brand-${Date.now()}` },
      headers: new Headers({ cookie }),
    });
    if (!org) throw new Error('createOrganization failed');
    organizationId = org.id;
  }
  console.log(`    organizationId = ${organizationId}`);

  console.log('3/8 accepting the DPA (via the real API endpoint, so the API must be running)...');
  const dpaRes = await fetch(`${API_URL}/v1/orgs/${organizationId}/dpa/accept`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      origin: env.DASHBOARD_URL,
    },
    body: JSON.stringify({ dpa_version: env.DPA_VERSION }),
  });
  if (!dpaRes.ok && dpaRes.status !== 409) {
    throw new Error(`dpa/accept failed: ${dpaRes.status} ${await dpaRes.text()}`);
  }

  console.log('4/8 creating (or reusing) the demo store...');
  const shopDomain = 'truepath-demo.myshopify.com';
  const store = await createStoreRepository(db).upsertByShopDomain(scopeFor(organizationId), {
    organizationId,
    shopDomain,
  });
  const storeId = store.id;
  const storeScope = scopeFor(organizationId, storeId);
  console.log(`    storeId = ${storeId}`);

  // No public endpoint yet for privacy-settings (SPEC §10; tracked, not built) — a direct update,
  // exactly like the existing integration tests' own setup, is the only way to confirm the India
  // opt-in gate for now.
  await db
    .update(schema.stores)
    .set({ privacyConfig: { checklist: { india_opt_in_confirmed_at: new Date().toISOString() } } })
    .where(eq(schema.stores.id, storeId));

  console.log(
    '5/8 connecting a Shopify integration (direct insert — no live OAuth tunnel here)...',
  );
  const storeKey = `pk_${randomBytes(18).toString('base64url').slice(0, 24)}`;
  const signingSecret = randomBytes(32).toString('hex');
  const credentialsJson = JSON.stringify({
    accessToken: 'shpat_dev-seed-not-real',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: 'shprt_dev-seed-not-real',
    refreshTokenExpiresAt: new Date(Date.now() + 7_776_000_000).toISOString(),
    scope: SHOPIFY_OAUTH_SCOPES.join(','),
    pixelSigningKeys: [{ kid: 's1', secret: signingSecret }],
  });
  const integration = await createIntegrationRepository(db).upsertShopify(storeScope, {
    storeId,
    externalAccountId: `gid://shopify/Shop/dev-seed-${storeId}`,
    credentialsJson,
    scopes: [...SHOPIFY_OAUTH_SCOPES],
    cipher,
  });
  await createIntegrationRepository(db).patchShopifySettings(storeScope, storeId, {
    store_key: storeKey,
    pixel_status: 'not_configured',
  });
  console.log(`    integrationId = ${integration.id}, store_key = ${storeKey}`);

  console.log('6/8 publishing the collector config to Redis...');
  const published = await publishCollectorConfig(
    { db, cipher, sink: redis, dpaVersion: env.DPA_VERSION },
    storeScope,
    storeId,
  );
  if (!published || published.status !== 'active') {
    console.log(
      `    WARNING: collector config is not active (${JSON.stringify(published)}) — check DPA_VERSION matches, and the India opt-in checklist.`,
    );
  } else {
    console.log('    collector config: active');
  }
  await redis.set('suppress:ready', String(Date.now()));

  console.log('7/8 sending 4 signed pixel events through the running Collector...');
  const visitorA = uuidV7(Date.now(), randomBytes(16));
  const visitorB = uuidV7(Date.now(), randomBytes(16));
  let sentAny = false;
  try {
    const health = await fetch(`${COLLECTOR_URL}/healthz`).catch(() => null);
    if (!health || !health.ok) throw new Error('collector not reachable');

    const send = async (body: string): Promise<{ status: number; text: string }> => {
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = createHmac('sha256', signingSecret)
        .update(collectSigningInput(ts, body))
        .digest('hex');
      const q = new URLSearchParams({ k: storeKey, ts, kid: 's1', sig });
      const res = await fetch(`${COLLECTOR_URL}/v1/collect?${q}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body,
      });
      return { status: res.status, text: await res.text().catch(() => '') };
    };

    const batch = (
      visitorId: string,
      pageUrl: string,
      eventName: 'page_viewed' | 'product_viewed',
    ): string =>
      JSON.stringify({
        v: 1,
        visitor_id: visitorId,
        visitor_new: true,
        sent_at: new Date().toISOString(),
        consent: { analytics: true, marketing: true, notice_version: 'v1' },
        events: [
          eventName === 'page_viewed'
            ? {
                event_name: 'page_viewed',
                event_id: uuidV7(Date.now(), randomBytes(16)),
                occurred_at: new Date().toISOString(),
                page_url: pageUrl,
                referrer: '',
              }
            : {
                event_name: 'product_viewed',
                event_id: uuidV7(Date.now(), randomBytes(16)),
                occurred_at: new Date().toISOString(),
                page_url: pageUrl,
                referrer: '',
                properties: {
                  product_id: 'demo-1',
                  variant_id: 'demo-1-v1',
                  price: { amount_paise: 149900, currency: 'INR' },
                },
              },
        ],
      });

    const results = await Promise.all([
      send(
        batch(
          visitorA,
          `https://${shopDomain}/products/demo?utm_source=facebook&utm_medium=paid_social&fbclid=IwARdevseed1`,
          'page_viewed',
        ),
      ),
      send(batch(visitorA, `https://${shopDomain}/products/demo`, 'product_viewed')),
      send(
        batch(
          visitorB,
          `https://${shopDomain}/products/demo?utm_source=google&utm_medium=cpc&gclid=Cj0devseed2`,
          'page_viewed',
        ),
      ),
      send(batch(visitorB, `https://${shopDomain}/products/demo`, 'product_viewed')),
    ]);
    console.log(`    posted 4 batches: ${results.map((r) => r.status).join(', ')}`);
    sentAny = results.every((r) => r.status === 204);
    if (sentAny) {
      console.log(
        '    (event-workers needs a moment to flush these into ClickHouse — up to ~2s, per its batch window)',
      );
    }
  } catch {
    console.log(
      `    SKIPPED: Collector not reachable at ${COLLECTOR_URL} — start it with 'pnpm --filter @truepath/collector dev' and re-run this script to backfill events.`,
    );
  }

  console.log('8/8 seeding two demo orders directly (mirrors the order-webhook handler)...');
  const orderRepo = createOrderRepository(db);
  const contact1 = hashContact(hasher, storeId, { phone: '+919812345670' });
  const delivered = await orderRepo.applySnapshot(storeScope, {
    storeId,
    externalOrderId: `dev-seed-${storeId}-1`,
    createdAtPlatform: new Date(Date.now() - 3 * 86_400_000),
    totalAmountPaise: 249900,
    currency: 'INR',
    paymentMethod: 'cod',
    refundedAmountPaise: null,
    financialStatus: 'paid',
    fulfilmentStatus: 'fulfilled',
    cancelledAt: null,
    pincodePrefix: '400',
    phoneHashHmac: contact1.phoneHmac ?? null,
    emailHashHmac: null,
    landingSite: `https://${shopDomain}/?utm_source=facebook&utm_medium=paid_social`,
    referringSite: null,
    noteAttributes: [],
    discountCodes: [],
    sourceTimestamp: new Date(Date.now() - 3 * 86_400_000),
    eventStatus: 'created',
    rawRef: `dev-seed-${storeId}-1-create`,
  });
  await orderRepo.linkVisitorIfUnset(storeScope, storeId, delivered.orderId, visitorA);
  await orderRepo.setAttributionConfidence(storeScope, storeId, delivered.orderId, 'high');

  const contact2 = hashContact(hasher, storeId, { email: 'dev-seed-shopper@example.com' });
  await orderRepo.applySnapshot(storeScope, {
    storeId,
    externalOrderId: `dev-seed-${storeId}-2`,
    createdAtPlatform: new Date(),
    totalAmountPaise: 89900,
    currency: 'INR',
    paymentMethod: 'prepaid',
    refundedAmountPaise: null,
    financialStatus: 'paid',
    fulfilmentStatus: 'unfulfilled',
    cancelledAt: null,
    pincodePrefix: '110',
    phoneHashHmac: null,
    emailHashHmac: contact2.emailHmac ?? null,
    landingSite: `https://${shopDomain}/?utm_source=google&utm_medium=cpc`,
    referringSite: null,
    noteAttributes: [],
    discountCodes: [],
    sourceTimestamp: new Date(),
    eventStatus: 'created',
    rawRef: `dev-seed-${storeId}-2-create`,
  });
  console.log('    2 orders seeded (1 matched to a visitor with attribution_confidence=high).');

  console.log('\nDone. Log in to the dashboard with:');
  console.log(`  email:    ${DEMO_EMAIL}`);
  console.log(`  password: ${DEMO_PASSWORD}`);
  console.log(`  storeId:  ${storeId}`);
  if (!sentAny) {
    console.log(
      '\nNote: pixel events were not sent (Collector unreachable) — Tracking will show "no events yet" until you start it and re-run this script.',
    );
  }

  await redis.quit();
  // createDb's pg.Pool has no exposed close (ADR-0016 boundary — callers never touch the pool
  // directly), so a one-shot script like this must exit explicitly or it hangs forever on the
  // pool's open connections, unlike apps/api|workers's own long-running entrypoints.
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('dev-seed failed:', error);
  process.exit(1);
});
