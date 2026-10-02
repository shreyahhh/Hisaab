CREATE TABLE "audit_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"entry" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"audit_log_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_outbox_status_check" CHECK ("audit_outbox"."status" IN ('pending', 'done', 'abandoned'))
);
--> statement-breakpoint
CREATE INDEX "audit_outbox_status_created_at_idx" ON "audit_outbox" USING btree ("status","created_at");