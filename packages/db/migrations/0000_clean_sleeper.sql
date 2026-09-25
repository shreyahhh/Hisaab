CREATE TYPE "public"."attribution_confidence" AS ENUM('high', 'low');--> statement-breakpoint
CREATE TYPE "public"."attribution_model" AS ENUM('first_click', 'last_click', 'last_non_direct', 'linear', 'time_decay', 'position_based');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('dpa_accepted', 'privacy_settings_changed', 'attribution_settings_changed', 'channel_rules_changed', 'integration_connected', 'integration_disconnected', 'integration_settings_changed', 'login_succeeded', 'login_failed', 'member_invited', 'member_invite_accepted', 'member_role_changed', 'member_removed', 'org_deletion_requested', 'org_deletion_cancelled', 'org_deleted', 'consent_region_confirmed', 'consent_default_on_warned', 'consent_default_on_paused', 'consent_default_on_resumed', 'dsr_created', 'dsr_completed', 'dsr_failed', 'dsr_followup_erasure', 'dsr_export_downloaded', 'report_exported', 'order_journey_viewed', 'audit_log_viewed', 'retention_run', 'system_scope_used', 'suppression_rebuilt', 'breach_created', 'breach_confirmed', 'breach_notified', 'breach_closed');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'system', 'shopify_webhook');--> statement-breakpoint
CREATE TYPE "public"."capi_event_name" AS ENUM('Purchase', 'DeliveredPurchase', 'RTO');--> statement-breakpoint
CREATE TYPE "public"."channel_slug" AS ENUM('meta_ads', 'google_ads', 'organic_search', 'email', 'whatsapp', 'influencer_affiliate', 'organic_social', 'direct', 'referral', 'other_campaign');--> statement-breakpoint
CREATE TYPE "public"."consent_source" AS ENUM('pixel_interaction', 'pixel_initial_state', 'pixel_refresh');--> statement-breakpoint
CREATE TYPE "public"."consent_state" AS ENUM('granted', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."delivery_rate_fallback_level" AS ENUM('store_payment_method', 'store', 'platform_default');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'in_transit', 'delivered', 'rto', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."dsr_type" AS ENUM('access', 'erasure', 'correction', 'store_erasure');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('shopify', 'meta', 'google_ads', 'shiprocket');--> statement-breakpoint
CREATE TYPE "public"."order_status_source" AS ENUM('shopify', 'shiprocket');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cod', 'prepaid', 'partial_cod');--> statement-breakpoint
CREATE TYPE "public"."revenue_basis" AS ENUM('placed', 'delivered');--> statement-breakpoint
CREATE TYPE "public"."store_platform" AS ENUM('shopify');--> statement-breakpoint
CREATE TYPE "public"."suppression_identifier_type" AS ENUM('visitor_id', 'identity_hash_hmac');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('erased', 'withdrawn');--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"inviter_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan" text,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"active_organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "dpa_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"dpa_version" text NOT NULL,
	"accepted_by_user_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_truncated" text
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"platform" "store_platform" DEFAULT 'shopify' NOT NULL,
	"shop_domain" text NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"installed_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"child_directed" boolean DEFAULT false NOT NULL,
	"retention_months" integer DEFAULT 13 NOT NULL,
	"privacy_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "stores_shop_domain_unique" UNIQUE("shop_domain")
);
--> statement-breakpoint
CREATE TABLE "ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"timezone" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"external_account_id" text,
	"encrypted_credentials" "bytea",
	"scopes" text[],
	"status" text DEFAULT 'pending' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"error" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"source" "order_status_source" NOT NULL,
	"status" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"raw_ref" text
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"external_order_id" text NOT NULL,
	"external_order_name" text,
	"created_at_platform" timestamp with time zone NOT NULL,
	"total_amount_paise" bigint NOT NULL,
	"currency" text NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"refunded_amount_paise" bigint DEFAULT 0 NOT NULL,
	"financial_status" text,
	"fulfilment_status" text,
	"delivery_status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"delivered_at" timestamp with time zone,
	"rto_at" timestamp with time zone,
	"pincode_prefix" text,
	"phone_hash_hmac" text,
	"email_hash_hmac" text,
	"visitor_id" text,
	"landing_site" text,
	"referring_site" text,
	"note_attributes" jsonb,
	"discount_codes" text[],
	"is_first_order" boolean,
	"attribution_confidence" "attribution_confidence" DEFAULT 'high' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_delivery_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"payment_method" "payment_method",
	"window_days" integer DEFAULT 90 NOT NULL,
	"delivery_rate" numeric(5, 4) NOT NULL,
	"resolved_orders" integer NOT NULL,
	"fallback_level" "delivery_rate_fallback_level" NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"actor_user_id" uuid,
	"actor_type" "audit_actor_type" NOT NULL,
	"action" "audit_action" NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "breach_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"severity" text NOT NULL,
	"description" text NOT NULL,
	"affected_tenants" uuid[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"notified_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"visitor_id" text NOT NULL,
	"purposes" text[] NOT NULL,
	"state" "consent_state" NOT NULL,
	"notice_version" text NOT NULL,
	"source" "consent_source" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dsr_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"type" "dsr_type" NOT NULL,
	"identity_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"result_summary" jsonb
);
--> statement-breakpoint
CREATE TABLE "suppressed_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"identifier_type" "suppression_identifier_type" NOT NULL,
	"identifier" text NOT NULL,
	"reason" "suppression_reason" NOT NULL,
	"dsr_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attribution_settings" (
	"store_id" uuid PRIMARY KEY NOT NULL,
	"default_model" "attribution_model" NOT NULL,
	"lookback_days" integer DEFAULT 30 NOT NULL,
	"revenue_basis" "revenue_basis" DEFAULT 'delivered' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capi_dispatch_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"event_name" "capi_event_name" NOT NULL,
	"event_id" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channel_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"match" jsonb NOT NULL,
	"channel" "channel_slug" NOT NULL,
	"sub_channel" text
);
--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpa_acceptances" ADD CONSTRAINT "dpa_acceptances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpa_acceptances" ADD CONSTRAINT "dpa_acceptances_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_delivery_rates" ADD CONSTRAINT "store_delivery_rates_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsr_requests" ADD CONSTRAINT "dsr_requests_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsr_requests" ADD CONSTRAINT "dsr_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressed_identities" ADD CONSTRAINT "suppressed_identities_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressed_identities" ADD CONSTRAINT "suppressed_identities_dsr_request_id_dsr_requests_id_fk" FOREIGN KEY ("dsr_request_id") REFERENCES "public"."dsr_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_settings" ADD CONSTRAINT "attribution_settings_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capi_dispatch_log" ADD CONSTRAINT "capi_dispatch_log_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capi_dispatch_log" ADD CONSTRAINT "capi_dispatch_log_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_rules" ADD CONSTRAINT "channel_rules_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dpa_acceptances_organization_id_idx" ON "dpa_acceptances" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "stores_organization_id_idx" ON "stores" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_store_id_idx" ON "ad_accounts" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "integrations_store_id_idx" ON "integrations" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "order_status_events_order_id_idx" ON "order_status_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_store_id_idx" ON "orders" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_store_id_external_order_id_key" ON "orders" USING btree ("store_id","external_order_id");--> statement-breakpoint
CREATE INDEX "store_delivery_rates_store_id_idx" ON "store_delivery_rates" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "audit_log_organization_id_idx" ON "audit_log" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "consent_records_store_id_visitor_id_idx" ON "consent_records" USING btree ("store_id","visitor_id");--> statement-breakpoint
CREATE INDEX "dsr_requests_store_id_idx" ON "dsr_requests" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressed_identities_unique" ON "suppressed_identities" USING btree ("store_id","identifier_type","identifier","reason");--> statement-breakpoint
CREATE INDEX "capi_dispatch_log_store_id_idx" ON "capi_dispatch_log" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capi_dispatch_log_event_id_key" ON "capi_dispatch_log" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "channel_rules_store_id_idx" ON "channel_rules" USING btree ("store_id");