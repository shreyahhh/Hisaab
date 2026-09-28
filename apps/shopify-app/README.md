# apps/shopify-app — Shopify embedded app + Web Pixel

Embedded admin app for install/settings, and the Web Pixel extension that does consent-gated
client-side event capture (SPEC §7.1, ADR-0008, `docs/architecture/lld/shopify-integration.md`,
`collector.md`).

The embedded admin app is still a **workspace stub** (issue #30: scaffold it with the Shopify CLI once the
Partner app is wired). The Web Pixel extension is real: see [`extensions/truepath-pixel`](extensions/truepath-pixel/README.md).
