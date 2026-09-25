ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_organization_id_organizations_id_fk";
--> statement-breakpoint
DROP INDEX "order_status_events_order_id_idx";--> statement-breakpoint
DROP INDEX "capi_dispatch_log_event_id_key";--> statement-breakpoint
ALTER TABLE "stores" ALTER COLUMN "platform" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "stores" ALTER COLUMN "platform" SET DEFAULT 'shopify';--> statement-breakpoint
ALTER TABLE "ad_accounts" ALTER COLUMN "provider" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "integrations" ALTER COLUMN "provider" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "order_status_events" ALTER COLUMN "source" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "payment_method" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "delivery_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "delivery_status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "store_delivery_rates" ALTER COLUMN "payment_method" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "action" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "consent_records" ALTER COLUMN "source" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "dsr_requests" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "capi_dispatch_log" ALTER COLUMN "event_name" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "channel_rules" ALTER COLUMN "channel" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_provider_id_account_id_key" ON "auth_accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_accounts_store_id_provider_external_id_key" ON "ad_accounts" USING btree ("store_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "integrations_store_id_provider_idx" ON "integrations" USING btree ("store_id","provider");--> statement-breakpoint
CREATE INDEX "order_status_events_order_id_source_occurred_at_idx" ON "order_status_events" USING btree ("order_id","source","occurred_at");--> statement-breakpoint
CREATE INDEX "orders_store_id_created_at_platform_idx" ON "orders" USING btree ("store_id","created_at_platform");--> statement-breakpoint
CREATE INDEX "audit_log_organization_id_created_at_idx" ON "audit_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "dsr_requests_store_id_status_idx" ON "dsr_requests" USING btree ("store_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "capi_dispatch_log_store_id_event_id_key" ON "capi_dispatch_log" USING btree ("store_id","event_id");--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_store_id_provider_external_account_id_key" UNIQUE NULLS NOT DISTINCT("store_id","provider","external_account_id");--> statement-breakpoint
ALTER TABLE "store_delivery_rates" ADD CONSTRAINT "store_delivery_rates_store_id_payment_method_key" UNIQUE NULLS NOT DISTINCT("store_id","payment_method");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_status_check" CHECK ("organizations"."status" IN ('active', 'pending_deletion', 'deleted'));--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_platform_check" CHECK ("stores"."platform" IN ('shopify'));--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_status_check" CHECK ("stores"."status" IN ('active', 'inactive', 'uninstalled', 'deleted'));--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_provider_check" CHECK ("ad_accounts"."provider" IN ('shopify', 'meta', 'google_ads', 'shiprocket'));--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_provider_check" CHECK ("integrations"."provider" IN ('shopify', 'meta', 'google_ads', 'shiprocket'));--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_status_check" CHECK ("integrations"."status" IN ('pending', 'active', 'error', 'needs_reauth', 'revoked'));--> statement-breakpoint
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_source_check" CHECK ("order_status_events"."source" IN ('shopify', 'shiprocket'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_method_check" CHECK ("orders"."payment_method" IN ('cod', 'prepaid', 'partial_cod'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_status_check" CHECK ("orders"."delivery_status" IN ('pending', 'in_transit', 'delivered', 'rto', 'cancelled'));--> statement-breakpoint
ALTER TABLE "store_delivery_rates" ADD CONSTRAINT "store_delivery_rates_payment_method_check" CHECK ("store_delivery_rates"."payment_method" IN ('cod', 'prepaid', 'partial_cod'));--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_check" CHECK ("audit_log"."action" IN ('dpa_accepted', 'privacy_settings_changed', 'attribution_settings_changed', 'channel_rules_changed', 'integration_connected', 'integration_disconnected', 'integration_settings_changed', 'login_succeeded', 'login_failed', 'member_invited', 'member_invite_accepted', 'member_role_changed', 'member_removed', 'org_deletion_requested', 'org_deletion_cancelled', 'org_deleted', 'consent_region_confirmed', 'consent_default_on_warned', 'consent_default_on_paused', 'consent_default_on_resumed', 'dsr_created', 'dsr_completed', 'dsr_failed', 'dsr_followup_erasure', 'dsr_export_downloaded', 'report_exported', 'order_journey_viewed', 'audit_log_viewed', 'retention_run', 'system_scope_used', 'suppression_rebuilt', 'breach_created', 'breach_confirmed', 'breach_notified', 'breach_closed'));--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_source_check" CHECK ("consent_records"."source" IN ('pixel_interaction', 'pixel_initial_state', 'pixel_refresh'));--> statement-breakpoint
ALTER TABLE "dsr_requests" ADD CONSTRAINT "dsr_requests_type_check" CHECK ("dsr_requests"."type" IN ('access', 'erasure', 'correction', 'store_erasure'));--> statement-breakpoint
ALTER TABLE "dsr_requests" ADD CONSTRAINT "dsr_requests_status_check" CHECK ("dsr_requests"."status" IN ('pending', 'in_progress', 'completed', 'failed'));--> statement-breakpoint
ALTER TABLE "capi_dispatch_log" ADD CONSTRAINT "capi_dispatch_log_event_name_check" CHECK ("capi_dispatch_log"."event_name" IN ('Purchase', 'DeliveredPurchase', 'RTO'));--> statement-breakpoint
ALTER TABLE "capi_dispatch_log" ADD CONSTRAINT "capi_dispatch_log_status_check" CHECK ("capi_dispatch_log"."status" IN ('queued', 'sent', 'skipped', 'failed'));--> statement-breakpoint
ALTER TABLE "channel_rules" ADD CONSTRAINT "channel_rules_channel_check" CHECK ("channel_rules"."channel" IN ('meta_ads', 'google_ads', 'organic_search', 'email', 'whatsapp', 'influencer_affiliate', 'organic_social', 'direct', 'referral', 'other_campaign'));--> statement-breakpoint
DROP TYPE "public"."audit_action";--> statement-breakpoint
DROP TYPE "public"."capi_event_name";--> statement-breakpoint
DROP TYPE "public"."channel_slug";--> statement-breakpoint
DROP TYPE "public"."consent_source";--> statement-breakpoint
DROP TYPE "public"."delivery_status";--> statement-breakpoint
DROP TYPE "public"."dsr_type";--> statement-breakpoint
DROP TYPE "public"."integration_provider";--> statement-breakpoint
DROP TYPE "public"."order_status_source";--> statement-breakpoint
DROP TYPE "public"."payment_method";--> statement-breakpoint
DROP TYPE "public"."store_platform";