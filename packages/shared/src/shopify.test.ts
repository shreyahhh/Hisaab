import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';
import { isShopifyShopDomain, shopifyEnvSchema, SHOPIFY_OAUTH_SCOPES } from './shopify.js';

describe('isShopifyShopDomain', () => {
  it.each(['my-store.myshopify.com', 'a.myshopify.com', 'store123.myshopify.com'])(
    'accepts %j',
    (value) => {
      expect(isShopifyShopDomain(value)).toBe(true);
    },
  );

  it.each([
    'MyStore.myshopify.com', // uppercase — callers normalise before checking
    'my store.myshopify.com',
    'my-store.myshopify.com.evil.com',
    'https://my-store.myshopify.com',
    '-my-store.myshopify.com',
    'my-store.shopify.com',
    '',
  ])('rejects %j', (value) => {
    expect(isShopifyShopDomain(value)).toBe(false);
  });
});

describe('SHOPIFY_OAUTH_SCOPES', () => {
  it('does not request read_customers or read_products (shopify-integration.md §2.3)', () => {
    expect(SHOPIFY_OAUTH_SCOPES).not.toContain('read_customers');
    expect(SHOPIFY_OAUTH_SCOPES).not.toContain('read_products');
  });

  it('requests read_fulfillments (issue #73: needed for the fulfillments/* webhook topics)', () => {
    expect(SHOPIFY_OAUTH_SCOPES).toContain('read_fulfillments');
  });
});

describe('shopifyEnvSchema', () => {
  function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    return {
      NODE_ENV: 'test',
      SHOPIFY_CLIENT_ID: 'client-id',
      SHOPIFY_CLIENT_SECRET: 'client-secret',
      SHOPIFY_APP_URL: 'https://api.example.com',
      SHOPIFY_OAUTH_STATE_SECRET: 'a'.repeat(32),
      ...overrides,
    };
  }

  it('parses a full config', () => {
    const result = parseEnv(shopifyEnvSchema, env());
    expect(result.success).toBe(true);
  });

  it('makes the previous client secret optional', () => {
    const result = parseEnv(shopifyEnvSchema, env());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.SHOPIFY_CLIENT_SECRET_PREVIOUS).toBeUndefined();
  });

  it.each([
    'SHOPIFY_CLIENT_ID',
    'SHOPIFY_CLIENT_SECRET',
    'SHOPIFY_APP_URL',
    'SHOPIFY_OAUTH_STATE_SECRET',
  ])('has no default: %s is required', (name) => {
    const result = parseEnv(shopifyEnvSchema, env({ [name]: undefined }));
    expect(result.success).toBe(false);
  });

  it('rejects a state secret shorter than 32 chars', () => {
    const result = parseEnv(shopifyEnvSchema, env({ SHOPIFY_OAUTH_STATE_SECRET: 'short' }));
    expect(result.success).toBe(false);
  });

  it('rejects a non-URL app URL', () => {
    const result = parseEnv(shopifyEnvSchema, env({ SHOPIFY_APP_URL: 'not-a-url' }));
    expect(result.success).toBe(false);
  });
});
