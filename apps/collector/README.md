# apps/collector — Ingest collector

Separate, stateless Fastify service exposing `POST /v1/collect` (SPEC §7.2). High-throughput pixel
event ingestion: consent check, PII normalise+hash, suppression check, geo lookup, then a write to
`stream:events-raw`. No Postgres connection by design (HLD §5, §7). See
`docs/architecture/lld/collector.md`.

Empty scaffold as of M0-1. Env validation at boot (durable Redis only, `COLLECTOR_PORT`) lands in
M0-2. The Fastify server and `/v1/collect` land in M1-5.
