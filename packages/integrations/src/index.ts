// Adapters for Shopify, Meta, Google Ads and Shiprocket, each isolated behind the
// IntegrationAdapter interface (SPEC §8, CLAUDE.md rule 8) in its own subfolder — e.g.
// packages/integrations/shopify — so a provider's API version bumps stay contained.
// See docs/architecture/lld/{shopify,meta,google-ads,shiprocket}-integration.md.
// Empty scaffold as of M0-1 — provider subfolders are added starting M1-1 (Shopify).

export const PACKAGE_NAME = '@truepath/integrations';
