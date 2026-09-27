import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { consumeShopifyOAuthState, issueShopifyOAuthState } from './shopifyOAuthState.js';
import { testRedis } from './testApp.js';

const SECRET = 'a'.repeat(32);

function deps(secret = SECRET) {
  return { redis: testRedis, secret };
}

describe('issueShopifyOAuthState / consumeShopifyOAuthState (ADR-0025)', () => {
  it('round-trips: a freshly issued token consumes successfully with the right claims', async () => {
    const claims = {
      userId: randomUUID(),
      organizationId: randomUUID(),
      shop: 'shop.myshopify.com',
    };
    const token = await issueShopifyOAuthState(deps(), claims);
    const result = await consumeShopifyOAuthState(deps(), token);
    expect(result).toEqual({ ok: true, claims });
  });

  it('is single-use: consuming the same token twice fails the second time', async () => {
    const claims = {
      userId: randomUUID(),
      organizationId: randomUUID(),
      shop: 'shop.myshopify.com',
    };
    const token = await issueShopifyOAuthState(deps(), claims);
    const first = await consumeShopifyOAuthState(deps(), token);
    const second = await consumeShopifyOAuthState(deps(), token);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'nonce_invalid' });
  });

  it('rejects a token signed with a different secret', async () => {
    const claims = {
      userId: randomUUID(),
      organizationId: randomUUID(),
      shop: 'shop.myshopify.com',
    };
    const token = await issueShopifyOAuthState(deps('b'.repeat(32)), claims);
    const result = await consumeShopifyOAuthState(deps(SECRET), token);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered payload (claims edited after signing)', async () => {
    const claims = {
      userId: randomUUID(),
      organizationId: randomUUID(),
      shop: 'shop.myshopify.com',
    };
    const token = await issueShopifyOAuthState(deps(), claims);
    const [payloadB64, signature] = token.split('.');
    const tamperedPayload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));
    tamperedPayload.organizationId = randomUUID();
    const tamperedToken = `${Buffer.from(JSON.stringify(tamperedPayload)).toString('base64url')}.${signature}`;
    const result = await consumeShopifyOAuthState(deps(), tamperedToken);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an expired token even though the signature is valid', async () => {
    const claims = {
      userId: randomUUID(),
      organizationId: randomUUID(),
      shop: 'shop.myshopify.com',
    };
    // Build the payload by hand with exp already in the past, signed with the real secret.
    const payload = { ...claims, nonce: randomUUID(), exp: Date.now() - 1000 };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const { createHmac } = await import('node:crypto');
    const signature = createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
    const result = await consumeShopifyOAuthState(deps(), `${payloadB64}.${signature}`);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects an unknown/garbage nonce that was never issued', async () => {
    const claims = {
      userId: randomUUID(),
      organizationId: randomUUID(),
      shop: 'shop.myshopify.com',
    };
    const payload = { ...claims, nonce: randomUUID(), exp: Date.now() + 60_000 };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const { createHmac } = await import('node:crypto');
    const signature = createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
    const result = await consumeShopifyOAuthState(deps(), `${payloadB64}.${signature}`);
    expect(result).toEqual({ ok: false, reason: 'nonce_invalid' });
  });

  it('rejects a malformed token with no separator', async () => {
    const result = await consumeShopifyOAuthState(deps(), 'not-a-valid-token');
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a payload missing required fields', async () => {
    const payloadB64 = Buffer.from(JSON.stringify({ userId: 'x' })).toString('base64url');
    const { createHmac } = await import('node:crypto');
    const signature = createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
    const result = await consumeShopifyOAuthState(deps(), `${payloadB64}.${signature}`);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('two independently issued tokens have independent nonces (consuming one leaves the other valid)', async () => {
    const claimsA = { userId: randomUUID(), organizationId: randomUUID(), shop: 'a.myshopify.com' };
    const claimsB = { userId: randomUUID(), organizationId: randomUUID(), shop: 'b.myshopify.com' };
    const tokenA = await issueShopifyOAuthState(deps(), claimsA);
    const tokenB = await issueShopifyOAuthState(deps(), claimsB);

    await consumeShopifyOAuthState(deps(), tokenA);
    const resultB = await consumeShopifyOAuthState(deps(), tokenB);
    expect(resultB).toEqual({ ok: true, claims: claimsB });
  });
});
