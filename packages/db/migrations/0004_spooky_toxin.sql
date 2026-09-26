CREATE TYPE "public"."role" AS ENUM('owner', 'admin', 'analyst', 'viewer');--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "role" SET DATA TYPE "public"."role" USING "role"::"public"."role";--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "role" SET DATA TYPE "public"."role" USING "role"::"public"."role";--> statement-breakpoint
CREATE INDEX "memberships_organization_id_user_id_idx" ON "memberships" USING btree ("organization_id","user_id");