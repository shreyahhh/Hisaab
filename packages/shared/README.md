# @truepath/shared

Cross-cutting TypeScript types, zod schemas, enums and constants shared by every `apps/*` and
`packages/*` (SPEC §4, CLAUDE.md rule 5: "typed interfaces/zod schemas in `packages/shared`").

## `env.ts` (M0-2)

Zod schemas for env validation at boot (CLAUDE.md rule 6), one per infra concern (Postgres,
ClickHouse, durable Redis, cache Redis, per-app ports) so each app composes only what it actually
connects to. `loadEnv(schema)` validates `process.env` and exits with a readable error on failure;
`parseEnv(schema, source)` is the pure, unit-tested core. `loadDotEnvIfPresent(path)` loads a local
`.env` via Node's built-in `process.loadEnvFile`, a no-op when the file/API isn't there (CI and
containers set real env vars directly).

`dpaEnvSchema` adds `DPA_VERSION`, required with no default (the DPA version tenants must accept before
tracking; privacy-dpdp.md §4.10).

## `dpa.ts`

The DPA version format (`DPA_VERSION_PATTERN`), the strict request body for
`POST /v1/orgs/:id/dpa/accept` (`DpaAcceptBodySchema`) and its response type.

## `events.ts`, `session.ts`, `uuid.ts` (M1-6a)

The pure half of the event pipeline (`docs/architecture/lld/event-pipeline.md`), with no I/O:

- `events.ts` — `parseLanding` (sanitised page URL + referrer → UTMs, click ids, referrer host),
  `classify` (SPEC §7.4 defaults plus merchant `channel_rules`, with numeric-only campaign / ad set / ad
  id mapping), `parseChannelRules` (validates rows; an invalid rule is skipped and its id reported),
  `resolveFbc` (Meta's server-side `fbc` format), `campaignFingerprint` and the ignorable-referrer list
  (shop hosts, Shopify checkout, Indian payment gateways).
- `session.ts` — `assignSession`, the reference implementation of the sessionisation rules. The Lua
  script in `apps/workers` applies the same rules atomically in Redis; a differential test keeps them equal.
- `uuid.ts` — `uuidV7(nowMs, randomBytes)` for server-generated session ids.

Otherwise an empty scaffold as of M0-1. Each module adds its own types here as it's built — see that
module's LLD under `docs/architecture/lld/`.
