CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"granted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"policy_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consents_user_id_purpose_key" UNIQUE("user_id","purpose"),
	CONSTRAINT "consents_purpose_check" CHECK ("consents"."purpose" IN ('email_reminders', 'product_analytics')),
	CONSTRAINT "consents_revoked_requires_granted_check" CHECK ("consents"."revoked_at" IS NULL OR "consents"."granted_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "ip_hash" text;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consents_user_id_idx" ON "consents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_user_id_idx" ON "audit_log" USING btree ("user_id");

-- ---------------------------------------------------------------------------
-- AR-14: the RLS policy for a tenant-scoped table ships in the SAME migration
-- that creates the table. `consents` is the only tenant-scoped table this
-- migration introduces — `audit_log`'s new `user_id`/`ip_hash` columns do NOT
-- make it tenant-scoped; it stays declared-exempt in
-- src/db/shared-tables.ts's AUDIT_TABLES, for the reasons written on
-- `auditLog` in src/db/schema/config.ts (cross-tenant operator readability is
-- the point of an audit log, and its `user_id` deliberately carries no
-- ON DELETE CASCADE — audit rows must survive the account they describe).
--
-- FORCE is required in addition to ENABLE, because `allmywallet_migrator`
-- owns this table and a table owner bypasses its own policies without it.
-- `current_setting('app.user_id')` is called WITHOUT `missing_ok`, so a
-- connection that never ran `withTenant` gets a raised error rather than
-- every tenant's rows back (TS-16). This is the exact template
-- `src/db/rls.ts`'s `tenantIsolationPolicySql` emits.
-- ---------------------------------------------------------------------------

ALTER TABLE "consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "consents"
	USING      ("user_id" = current_setting('app.user_id')::uuid)
	WITH CHECK ("user_id" = current_setting('app.user_id')::uuid);