CREATE TABLE "opportunity_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"state" text NOT NULL,
	"quote_observed_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunity_notifications_rule_id_state_quote_observed_at_key" UNIQUE("rule_id","state","quote_observed_at"),
	CONSTRAINT "opportunity_notifications_state_check" CHECK ("opportunity_notifications"."state" IN ('buy', 'hold', 'sell'))
);
--> statement-breakpoint
CREATE TABLE "opportunity_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"lower_bound" numeric(20, 8),
	"lower_state" text,
	"upper_bound" numeric(20, 8),
	"upper_state" text,
	"default_state" text DEFAULT 'hold' NOT NULL,
	"last_state" text,
	"last_evaluated_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunity_rules_user_id_asset_id_key" UNIQUE("user_id","asset_id"),
	CONSTRAINT "opportunity_rules_lower_state_check" CHECK ("opportunity_rules"."lower_state" IS NULL OR "opportunity_rules"."lower_state" IN ('buy', 'hold', 'sell')),
	CONSTRAINT "opportunity_rules_upper_state_check" CHECK ("opportunity_rules"."upper_state" IS NULL OR "opportunity_rules"."upper_state" IN ('buy', 'hold', 'sell')),
	CONSTRAINT "opportunity_rules_default_state_check" CHECK ("opportunity_rules"."default_state" IN ('buy', 'hold', 'sell')),
	CONSTRAINT "opportunity_rules_last_state_check" CHECK ("opportunity_rules"."last_state" IS NULL OR "opportunity_rules"."last_state" IN ('buy', 'hold', 'sell')),
	CONSTRAINT "opportunity_rules_at_least_one_bound_check" CHECK ("opportunity_rules"."lower_bound" IS NOT NULL OR "opportunity_rules"."upper_bound" IS NOT NULL),
	CONSTRAINT "opportunity_rules_lower_bound_state_paired_check" CHECK (("opportunity_rules"."lower_bound" IS NULL) = ("opportunity_rules"."lower_state" IS NULL)),
	CONSTRAINT "opportunity_rules_upper_bound_state_paired_check" CHECK (("opportunity_rules"."upper_bound" IS NULL) = ("opportunity_rules"."upper_state" IS NULL)),
	CONSTRAINT "opportunity_rules_bounds_order_check" CHECK ("opportunity_rules"."lower_bound" IS NULL OR "opportunity_rules"."upper_bound" IS NULL OR "opportunity_rules"."lower_bound" < "opportunity_rules"."upper_bound"),
	CONSTRAINT "opportunity_rules_lower_bound_positive_check" CHECK ("opportunity_rules"."lower_bound" IS NULL OR "opportunity_rules"."lower_bound" > 0),
	CONSTRAINT "opportunity_rules_upper_bound_positive_check" CHECK ("opportunity_rules"."upper_bound" IS NULL OR "opportunity_rules"."upper_bound" > 0)
);
--> statement-breakpoint
ALTER TABLE "opportunity_notifications" ADD CONSTRAINT "opportunity_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_notifications" ADD CONSTRAINT "opportunity_notifications_rule_id_opportunity_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."opportunity_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_rules" ADD CONSTRAINT "opportunity_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_rules" ADD CONSTRAINT "opportunity_rules_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opportunity_notifications_user_id_idx" ON "opportunity_notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "opportunity_notifications_rule_id_sent_at_idx" ON "opportunity_notifications" USING btree ("rule_id","sent_at");--> statement-breakpoint
CREATE INDEX "opportunity_rules_user_id_idx" ON "opportunity_rules" USING btree ("user_id");

-- ---------------------------------------------------------------------------
-- AR-14: the RLS policy ships in the SAME migration that creates the table.
--
-- `opportunity_rules` states the exact prices one person is watching on their
-- own holdings, and `opportunity_notifications` is a record of every email
-- that told them a threshold had been crossed — both as personal as the
-- position they are watching. A table live for a single deploy without its
-- policy is a table with no isolation.
--
-- FORCE as well as ENABLE: `allmywallet_migrator` owns the table and a table
-- owner bypasses its own policies without it. `current_setting('app.user_id')`
-- is called WITHOUT `missing_ok`, so a connection that never ran `withTenant`
-- raises rather than returning every tenant's rows (TS-16).
-- ---------------------------------------------------------------------------

ALTER TABLE "opportunity_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "opportunity_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "opportunity_rules"
	USING      ("user_id" = current_setting('app.user_id')::uuid)
	WITH CHECK ("user_id" = current_setting('app.user_id')::uuid);
--> statement-breakpoint
ALTER TABLE "opportunity_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "opportunity_notifications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "opportunity_notifications"
	USING      ("user_id" = current_setting('app.user_id')::uuid)
	WITH CHECK ("user_id" = current_setting('app.user_id')::uuid);

-- ---------------------------------------------------------------------------
-- AR-69/DV-27 — expand/contract.
--
-- There is no staging environment, so this migration must be safe to run
-- alongside the *previous* application version and safe to leave in place if
-- that deploy is rolled back. Both tables are wholly new: the previous
-- application version never references `opportunity_rules` or
-- `opportunity_notifications` at all, so it neither reads nor writes them and
-- is unaffected by their existence either way. There is no column added to
-- an existing table, no rename and no drop here, so there is nothing to
-- expand in a later migration and nothing that needs a two-step sequence —
-- this is the trivial, single-step case AR-69 always allows: creating
-- something nobody depends on yet.
-- ---------------------------------------------------------------------------