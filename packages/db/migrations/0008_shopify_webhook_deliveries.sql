CREATE TABLE "shopify_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"webhook_id" text NOT NULL,
	"topic" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shopify_webhook_deliveries" ADD CONSTRAINT "shopify_webhook_deliveries_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_webhook_deliveries_store_id_webhook_id_uniq" ON "shopify_webhook_deliveries" USING btree ("store_id","webhook_id");--> statement-breakpoint
CREATE INDEX "shopify_webhook_deliveries_received_at_idx" ON "shopify_webhook_deliveries" USING btree ("received_at");