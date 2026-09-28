# TruePath Web Pixel (`truepath-pixel`)

The consent-gated, client-side half of tracking (SPEC §7.1, `docs/architecture/lld/collector.md` §2.2,
`shopify-integration.md` §2.2). It runs in Shopify's strict Web Pixel sandbox, maps Shopify's standard
events to the Collector's strict wire contract (`packages/shared/src/collector.ts`), batches them, signs
each batch, and sends it with `fetch(..., { keepalive: true })`.

## What it guarantees

1. **Consent first (P-1, P-3).** Nothing but `consent_withdrawn` is sent while analytics processing is not
   allowed. A withdrawal discards everything still buffered and is sent immediately.
2. **Minimal output.** Events that would not fit the schema are dropped here rather than sent. The only
   raw identifiers are the checkout `contact` (phone/email) on the two checkout events — the Collector
   hashes and discards them. `fbp`/`fbc` are sent only with marketing consent. It stores one visitor id and
   one consent record in the sandbox's storage, nothing else.
3. **Never disturbs the page.** Every error is swallowed; a failed send is not retried.

`visitor_new` is true only on the batch in which the pixel created the visitor id, and every
`consent_granted` carries a `trigger` (`interaction` | `initial_state` | `refresh`) — together they feed the
default-on-region signal (SPEC v0.6 P-1).

## Layout

| File | Role |
|---|---|
| `shopify.extension.toml` | Extension manifest (flat keys — verified against Shopify's docs, 2026-09) |
| `src/index.ts` | **Deploy entry** — the only file that imports `@shopify/web-pixels-extension` |
| `src/pixel.ts` | The state machine: consent, visitor id, buffering, batching, signing |
| `src/mapping.ts` | Shopify event → wire event (pure, never throws) |
| `src/env.ts` | Real sandbox implementations (`fetch`, Web Crypto, timers) |
| `src/types.ts` | The slice of the Web Pixels API used, declared locally |
| `src/uuid.ts` | UUID v7 |
| `src/*.test.ts`, `src/testHarness.ts` | A fake sandbox; `pixel.contract.test.ts` pins the wire contract |

The pixel imports **no runtime code** from `@truepath/shared` (it is bundled for a browser); a contract test
pins its few copied constants and validates every batch it produces against the real `CollectBatch` schema.

## Not yet done — needs a human

- **Deploying it.** `shopify app deploy` needs the Partner account login and the app registered; a
  Shopify-CLI-scaffolded app is tracked in issue #30. The `uid` in the manifest is assigned by the CLI.
- **`@shopify/web-pixels-extension`.** `src/index.ts` imports it, and it is not installed (a new dependency
  needs approval, CLAUDE.md). `index.ts` is excluded from this app's typecheck for that reason. Add it to the
  extension's dependencies when deploying.
- **Live verification in a dev store**, none of which unit tests can settle (collector.md §9, Q2–Q3):
  does `fetch keepalive` survive page unload from the sandbox; which events Shopify replays after late
  consent and with what `occurred_at`; whether `visitorConsentCollected` reaches a late-loading pixel and
  after withdrawal; and the format of `checkout.order.id` (numeric or `gid://`).
- Until those are confirmed, the runtime default-on **auto-pause** stays behind its flag (HLD §8).
