-- ---------------------------------------------------------------------------
-- SPEC-004 (#7) — consent records, and the data-subject columns on `audit_log`.
--
-- BR-004-09: consent is granular, per-purpose and versioned. Each row records
-- the policy version in force when the decision was made, so a later policy
-- change cannot retroactively reinterpret what someone agreed to.
--
-- **The `audit_log` collision, resolved.** SPEC-002 already created
-- `audit_log` (migration 0002) for configuration changes: no `user_id`, no
-- foreign key, declared exempt from tenant scoping in
-- `src/db/shared-tables.ts`. SPEC-004's plan asked for a table of the same
-- name with a different shape. Rather than create a second `audit_log` or
-- recreate the existing one, this migration **extends** it — `user_id` and
-- `ip_hash`, both nullable, which is expand/contract safe (AR-69) against the
-- running previous version because every existing row and every existing
-- insert remains valid.
--
-- `user_id` deliberately carries **no ON DELETE CASCADE**, which is the one
-- place this schema breaks the AR-27 pattern on purpose. `shared-tables.ts`
-- posed the question — are a deleted account's audit rows purged, anonymised
-- or kept — and the answer is kept: an audit trail that disappears with the
-- account it describes cannot evidence that the deletion was carried out
-- correctly, which is the thing BR-004-17 exists to prove. The deletion job
-- nulls `user_id` instead, leaving the trail intact and unlinked.
--
-- Renamed from drizzle-kit's generated `0010_pink_kat_farrell` to the
-- repository's descriptive convention; `meta/_journal.json`'s tag was updated
-- to match, and the meta snapshot is indexed by position rather than name so
-- it needed no change. Verified with a follow-up `db:generate` reporting no
-- pending schema changes.
-- ---------------------------------------------------------------------------

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