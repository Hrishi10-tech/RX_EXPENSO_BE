ALTER TYPE "public"."message_kind" ADD VALUE 'dispute';--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "expense_messages" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "exports" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "last_digest_on" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "designation" text;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_messages_client_uq" ON "expense_messages" USING btree ("author_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exports_client_uq" ON "exports" USING btree ("requested_by","client_id");--> statement-breakpoint
CREATE INDEX "exports_queue_idx" ON "exports" USING btree ("status","created_at") WHERE "exports"."status" in ('queued', 'building');