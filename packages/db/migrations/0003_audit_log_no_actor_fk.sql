ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actor_user_id_users_id_fk";
--> statement-breakpoint
CREATE INDEX "audit_log_actor_user_id_idx" ON "audit_log" USING btree ("actor_user_id");