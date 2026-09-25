# apps/shopify-app — Shopify embedded app + Web Pixel

Embedded admin app for install/settings, and the Web Pixel extension that does consent-gated
client-side event capture (SPEC §7.1, ADR-0008, `docs/architecture/lld/shopify-integration.md`,
`collector.md`).

This is a **workspace stub only** as of M0-1: just enough (`package.json`, empty `src/`) for the
workspace path and turbo pipeline to exist. The real app is generated with the official Shopify
app template/CLI at M1-1, which will replace these files rather than build on them.
