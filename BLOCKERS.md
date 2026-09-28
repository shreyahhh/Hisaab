# Blockers

Things the M1 goal run could not finish on its own, and exactly what unblocks each. Newest first. Each is
also tracked as a GitHub issue where it is deferred code work.

## 1. No real orders in the connected dev store — real-order ingestion is unproven live
**Ticket:** M1-3 / M1-3b (Shopify backfill). **Status:** pipeline verified, live data missing.

The backfill ran end to end against `louis-belcher-store.myshopify.com` twice (start → Shopify bulk
operation → `bulk_result` → `settings.backfill.status = done`). Both times Shopify's own
`rootObjectCount` was **0**, and we applied 0, so there is nothing to ingest: the store has no orders
created in the last 60 days that this app's token can see. The mapping/apply path is covered by worker
tests (real Postgres, faked adapter) and adapter tests (real HTTP shapes), but not by a live order.

**Unblock (you):** create one or two test orders in the dev store (Admin → Orders → Create order, mark as
paid or as a COD/manual payment), then:

```sh
pnpm --filter @truepath/workers dev            # the consumer, if not already running
pnpm --filter @truepath/workers dev:backfill start  ea9ceaee-fd4c-47f9-a555-532cf8a4a953 60
pnpm --filter @truepath/workers dev:backfill status ea9ceaee-fd4c-47f9-a555-532cf8a4a953   # wait for a bulk_operation_id
pnpm --filter @truepath/workers dev:backfill apply  ea9ceaee-fd4c-47f9-a555-532cf8a4a953
```

`status` should then show `orders_applied` = `orders_reported` = the number of orders you created, and
`select external_order_id, total_amount_paise, payment_method from orders` in Postgres will show them.
Live `orders/create` webhooks additionally need a public URL for the API (a tunnel); not set up here.

## 2. The Web Pixel cannot be deployed or seen live from here
**Ticket:** M1-4. **Issue:** #43. Needs the Shopify Partner login (`shopify app deploy`) and approval to
add `@shopify/web-pixels-extension`. Until then no pixel event can originate from a real storefront; the
pixel is verified against a fake sandbox and the real `CollectBatch` schema only.
