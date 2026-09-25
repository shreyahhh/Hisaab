# apps/workers — Background workers

All BullMQ queue consumers and the `event-workers` Redis Stream consumer group named in HLD §8:
`ad-sync-meta`, `ad-sync-google-ads`, `shiprocket-sync`, `shopify-sync`, `identity-stitch`,
`attribution-run`, `capi-dispatch`, `order-status-reconcile`, `retention`, `dsr`.

Empty scaffold as of M0-1. Env validation at boot (Postgres, ClickHouse, durable Redis only —
no cache Redis) lands in M0-2. The queue consumers land starting M1-6 (event pipeline) and M2
(ad/logistics sync); see `docs/architecture/lld/event-pipeline.md`, `identity-stitching.md`,
`attribution-engine.md`.
