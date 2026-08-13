CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_key" text NOT NULL,
	"previous_value" jsonb,
	"new_value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"level" text NOT NULL,
	"user_id" uuid,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_overrides_key_level_user_id_key" UNIQUE("key","level","user_id"),
	CONSTRAINT "config_overrides_level_check" CHECK ("config_overrides"."level" IN ('deployment', 'tenant', 'user')),
	CONSTRAINT "config_overrides_level_user_id_check" CHECK (("config_overrides"."level" = 'deployment' AND "config_overrides"."user_id" IS NULL) OR ("config_overrides"."level" IN ('tenant', 'user') AND "config_overrides"."user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "runtime_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"reason" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "config_overrides" ADD CONSTRAINT "config_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "config_overrides_user_id_idx" ON "config_overrides" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "config_overrides_key_idx" ON "config_overrides" USING btree ("key");
--> statement-breakpoint
-- AR-14 / ARCHITECTURE §5: FORCE is required in addition to ENABLE, because the
-- migrator role owns this table and a table owner bypasses its own RLS policies
-- unless FORCE ROW LEVEL SECURITY is set.
ALTER TABLE "config_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "config_overrides" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- This table is unusual: it mixes global operator rows (level='deployment',
-- user_id IS NULL) with tenant rows (level IN ('tenant','user')). One
-- permissive predicate covering both cannot express the rule that matters, so
-- there are two policies.
--
-- SPEC-002 BR-002-10: tenant rows are tenant data — own rows only, read and write.
CREATE POLICY "tenant_isolation" ON "config_overrides"
	USING ("user_id" = current_setting('app.user_id', true)::uuid)
	WITH CHECK ("user_id" = current_setting('app.user_id', true)::uuid);--> statement-breakpoint

-- Deployment rows are global. They must be *readable* with no tenant context at
-- all, because that is how deployment-level resolution works at process boot,
-- before any request or tenant exists (src/config/resolve.ts) — hence
-- missing_ok = true, which returns NULL instead of raising when app.user_id was
-- never set.
--
-- The WITH CHECK is the security-relevant half, and it keys on tenant context
-- rather than on role. Writing a deployment row is permitted only when no
-- tenant context is set at all:
--
--   * a user request always runs inside withTenant (AR-11), so app.user_id is
--     always set, so a user can never write a global row — BR-002-03 calls this
--     "a tenant-isolation concern, not just validation", and this is what makes
--     that true at the RLS floor rather than only in authorizeConfigWrite;
--   * an operator or boot-time path runs with no tenant context, so it can.
--
-- A single policy with `user_id IS NULL` in its WITH CHECK would let any
-- authenticated tenant insert global operator configuration. Dropping the
-- deployment write path altogether would lock operators out, since FORCE
-- subjects the owning role to the policy too.
CREATE POLICY "deployment_config" ON "config_overrides"
	USING ("user_id" IS NULL)
	WITH CHECK (
		"user_id" IS NULL
		AND coalesce(current_setting('app.user_id', true), '') = ''
	);
