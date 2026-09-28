ALTER TABLE "orders" ALTER COLUMN "attribution_confidence" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "attribution_confidence" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "order_status_events_order_id_source_raw_ref_uniq" ON "order_status_events" USING btree ("order_id","source","raw_ref");