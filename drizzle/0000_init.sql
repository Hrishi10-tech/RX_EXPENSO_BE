CREATE TYPE "public"."attachment_kind" AS ENUM('receipt', 'document');--> statement-breakpoint
CREATE TYPE "public"."budget_source" AS ENUM('pool', 'individual', 'unbudgeted');--> statement-breakpoint
CREATE TYPE "public"."budget_type" AS ENUM('pool', 'individual');--> statement-breakpoint
CREATE TYPE "public"."expense_category" AS ENUM('airfare', 'train', 'cab', 'fuel_toll', 'accommodation', 'meals', 'client_entertainment', 'event_fee', 'printing', 'courier', 'internet_phone', 'visa_passport', 'other');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('open', 'ready', 'verified', 'part_paid', 'reimbursed');--> statement-breakpoint
CREATE TYPE "public"."doc_scope" AS ENUM('trip', 'claim', 'expense');--> statement-breakpoint
CREATE TYPE "public"."doc_type" AS ENUM('payment_proof', 'invoice', 'approval_note', 'bank_statement', 'other');--> statement-breakpoint
CREATE TYPE "public"."end_method" AS ENUM('member', 'finance');--> statement-breakpoint
CREATE TYPE "public"."export_scope" AS ENUM('trip', 'member', 'each', 'trip_and_each');--> statement-breakpoint
CREATE TYPE "public"."export_status" AS ENUM('queued', 'building', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."join_status" AS ENUM('invited', 'accepted', 'declined', 'withdrawn', 'expired');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('query', 'reply', 'reject', 'note');--> statement-breakpoint
CREATE TYPE "public"."paid_by" AS ENUM('self', 'company');--> statement-breakpoint
CREATE TYPE "public"."payment_mode" AS ENUM('upi', 'cash', 'card', 'company');--> statement-breakpoint
CREATE TYPE "public"."reimbursement_mode" AS ENUM('bank_transfer', 'upi', 'cash');--> statement-breakpoint
CREATE TYPE "public"."start_method" AS ENUM('manual', 'automatic');--> statement-breakpoint
CREATE TYPE "public"."trip_purpose" AS ENUM('client_meeting', 'conference', 'training', 'audit', 'installation', 'other');--> statement-breakpoint
CREATE TYPE "public"."trip_status" AS ENUM('scheduled', 'active', 'extended', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."trip_type" AS ENUM('same_day', 'multi_day');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('pending', 'uploaded');--> statement-breakpoint
CREATE TYPE "public"."verification" AS ENUM('pending', 'verified', 'query', 'rejected');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text,
	"kind" "attachment_kind" NOT NULL,
	"trip_id" uuid NOT NULL,
	"expense_id" uuid,
	"member_user_id" uuid,
	"message_id" uuid,
	"doc_type" "doc_type",
	"doc_scope" "doc_scope",
	"visible_to_member" boolean DEFAULT true NOT NULL,
	"storage_key" text,
	"original_name" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"width" integer,
	"height" integer,
	"sha256" text,
	"captured_at" timestamp with time zone,
	"status" "upload_status" DEFAULT 'pending' NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid,
	"trip_id" uuid,
	"member_user_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"type" "budget_type" NOT NULL,
	"member_user_id" uuid,
	"old_paise" bigint,
	"new_paise" bigint,
	"note" text,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"type" "budget_type" NOT NULL,
	"member_user_id" uuid,
	"amount_paise" bigint NOT NULL,
	"alert_level" integer DEFAULT 0 NOT NULL,
	"set_by" uuid NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expense_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"side" text NOT NULL,
	"kind" "message_kind" NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text,
	"trip_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"spent_at" timestamp with time zone NOT NULL,
	"category" "expense_category" NOT NULL,
	"description" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"payment_mode" "payment_mode" NOT NULL,
	"paid_by" "paid_by" NOT NULL,
	"budget_source" "budget_source",
	"needs_budget_choice" boolean DEFAULT false NOT NULL,
	"remarks" text,
	"verification" "verification" DEFAULT 'pending' NOT NULL,
	"approved_paise" bigint,
	"approval_reason" text,
	"finance_remark" text,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"device_time" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_via" text DEFAULT 'web' NOT NULL,
	"scope" "export_scope" NOT NULL,
	"member_user_id" uuid,
	"formats" text[] NOT NULL,
	"location_id" uuid,
	"date_from" date,
	"date_to" date,
	"provisional" boolean DEFAULT false NOT NULL,
	"status" "export_status" DEFAULT 'queued' NOT NULL,
	"base_name" text,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing_receipts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"client_id" text,
	"city" text NOT NULL,
	"venue" text,
	"address" text,
	"lat" double precision,
	"lng" double precision,
	"arrival_date" date NOT NULL,
	"departure_date" date NOT NULL,
	"notes" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"added_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"trip_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"channel" text DEFAULT 'app' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"pushed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"member_user_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"paid_on" date NOT NULL,
	"mode" "reimbursement_mode" NOT NULL,
	"reference" text,
	"proof_attachment_id" uuid,
	"note" text,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ref_counters" (
	"year" integer PRIMARY KEY NOT NULL,
	"last" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"client" text NOT NULL,
	"device_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "trip_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"join_status" "join_status" DEFAULT 'invited' NOT NULL,
	"invited_by" uuid,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"invite_reminded_at" timestamp with time zone,
	"actual_start" timestamp with time zone,
	"start_method" "start_method",
	"start_device_time" timestamp with time zone,
	"start_received_at" timestamp with time zone,
	"start_backdated" boolean DEFAULT false NOT NULL,
	"actual_end" timestamp with time zone,
	"end_method" "end_method",
	"end_reason" text,
	"ended_by" uuid,
	"end_device_time" timestamp with time zone,
	"end_received_at" timestamp with time zone,
	"extension_prompted_at" timestamp with time zone,
	"last_reminder_at" timestamp with time zone,
	"claim_status" "claim_status" DEFAULT 'open' NOT NULL,
	"claim_status_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reopened_at" timestamp with time zone,
	"reopen_reason" text,
	"reopened_by" uuid,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text NOT NULL,
	"client_id" text,
	"name" text NOT NULL,
	"type" "trip_type" NOT NULL,
	"purpose" "trip_purpose" NOT NULL,
	"client_event" text,
	"department_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"scheduled_start" timestamp with time zone NOT NULL,
	"tentative_end" timestamp with time zone NOT NULL,
	"primary_city" text NOT NULL,
	"notes" text,
	"status" "trip_status" DEFAULT 'scheduled' NOT NULL,
	"entered_after_start" boolean DEFAULT false NOT NULL,
	"created_offline" boolean DEFAULT false NOT NULL,
	"copied_from" uuid,
	"first_start_at" timestamp with time zone,
	"extended_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"daily_digest" boolean DEFAULT false NOT NULL,
	"theme" text DEFAULT 'system' NOT NULL,
	"notification_prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_code" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"department_id" uuid NOT NULL,
	"is_finance" boolean DEFAULT false NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"password_hash" text,
	"active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"first_mobile_login_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_member_user_id_users_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_expense_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."expense_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_member_user_id_users_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_changes" ADD CONSTRAINT "budget_changes_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_changes" ADD CONSTRAINT "budget_changes_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_changes" ADD CONSTRAINT "budget_changes_member_user_id_users_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_changes" ADD CONSTRAINT "budget_changes_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_member_user_id_users_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_messages" ADD CONSTRAINT "expense_messages_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_messages" ADD CONSTRAINT "expense_messages_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_messages" ADD CONSTRAINT "expense_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_member_user_id_users_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_member_user_id_users_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_proof_attachment_id_attachments_id_fk" FOREIGN KEY ("proof_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_expense_idx" ON "attachments" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "attachments_trip_idx" ON "attachments" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_client_uq" ON "attachments" USING btree ("uploaded_by","client_id");--> statement-breakpoint
CREATE INDEX "audit_trip_idx" ON "audit_log" USING btree ("trip_id","at");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_id","at");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "budget_changes_trip_idx" ON "budget_changes" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "budgets_trip_idx" ON "budgets" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_pool_uq" ON "budgets" USING btree ("trip_id") WHERE "budgets"."type" = 'pool' and "budgets"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_individual_uq" ON "budgets" USING btree ("trip_id","member_user_id") WHERE "budgets"."type" = 'individual' and "budgets"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "departments_name_uq" ON "departments" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "device_tokens_token_uq" ON "device_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "expense_messages_expense_idx" ON "expense_messages" USING btree ("expense_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_client_uq" ON "expenses" USING btree ("user_id","client_id");--> statement-breakpoint
CREATE INDEX "expenses_trip_idx" ON "expenses" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "expenses_user_idx" ON "expenses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "expenses_location_idx" ON "expenses" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "exports_trip_idx" ON "exports" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "locations_trip_idx" ON "locations" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_client_uq" ON "locations" USING btree ("trip_id","client_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "otp_codes_user_idx" ON "otp_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "payments_claim_idx" ON "payments" USING btree ("trip_id","member_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_uq" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_members_uq" ON "trip_members" USING btree ("trip_id","user_id");--> statement-breakpoint
CREATE INDEX "trip_members_user_idx" ON "trip_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trips_ref_uq" ON "trips" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "trips_client_uq" ON "trips" USING btree ("owner_id","client_id");--> statement-breakpoint
CREATE INDEX "trips_status_idx" ON "trips" USING btree ("status");--> statement-breakpoint
CREATE INDEX "trips_department_idx" ON "trips" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "trips_start_idx" ON "trips" USING btree ("scheduled_start");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_code_uq" ON "users" USING btree ("employee_code");--> statement-breakpoint
CREATE INDEX "users_department_idx" ON "users" USING btree ("department_id");