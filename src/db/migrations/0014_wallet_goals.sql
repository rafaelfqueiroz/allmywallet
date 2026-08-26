CREATE TABLE "wallet_goals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"basis" text,
	"period" text,
	"achieved_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_goals_kind_check" CHECK ("wallet_goals"."kind" IN ('growth', 'earnings')),
	CONSTRAINT "wallet_goals_basis_check" CHECK ("wallet_goals"."basis" IS NULL OR "wallet_goals"."basis" IN ('invested', 'current_value')),
	CONSTRAINT "wallet_goals_period_check" CHECK ("wallet_goals"."period" IS NULL OR "wallet_goals"."period" IN ('monthly', 'yearly')),
	CONSTRAINT "wallet_goals_amount_positive_check" CHECK ("wallet_goals"."amount" > 0),
	CONSTRAINT "wallet_goals_kind_fields_check" CHECK (("wallet_goals"."kind" = 'growth' AND "wallet_goals"."basis" IS NOT NULL AND "wallet_goals"."period" IS NULL)
       OR ("wallet_goals"."kind" = 'earnings' AND "wallet_goals"."period" IS NOT NULL AND "wallet_goals"."basis" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "wallet_allocation_events" ADD COLUMN "cost_basis_after" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "wallet_goals" ADD CONSTRAINT "wallet_goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_goals" ADD CONSTRAINT "wallet_goals_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_goals_user_id_wallet_id_idx" ON "wallet_goals" USING btree ("user_id","wallet_id");

-- ---------------------------------------------------------------------------
-- AR-14: the RLS policy ships in the SAME migration that creates the table.
--
-- `wallet_goals` states the figures one person is aiming for on their own
-- money — as personal as the wallet's actual holdings. A table live for a
-- single deploy without its policy is a table with no isolation.
--
-- FORCE as well as ENABLE: `allmywallet_migrator` owns the table and a table
-- owner bypasses its own policies without it. `current_setting('app.user_id')`
-- is called WITHOUT `missing_ok`, so a connection that never ran `withTenant`
-- raises rather than returning every tenant's rows (TS-16).
-- ---------------------------------------------------------------------------

ALTER TABLE "wallet_goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallet_goals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "wallet_goals"
	USING      ("user_id" = current_setting('app.user_id')::uuid)
	WITH CHECK ("user_id" = current_setting('app.user_id')::uuid);

-- ---------------------------------------------------------------------------
-- AR-69/DV-27 — `wallet_allocation_events.cost_basis_after` is expand-only,
-- and stays that way.
--
-- There is no staging environment, so this migration must be safe to run
-- alongside the *previous* application version and safe to leave in place if
-- that deploy is rolled back. The column is nullable with no default and no
-- backfill: the previous code never mentions it, so it keeps inserting event
-- rows exactly as before and every one of those inserts still satisfies
-- `NOT NULL`-free "no column value supplied" — there is nothing to violate.
-- Rolling the deploy back leaves an unused nullable column, which is inert.
--
-- No backfill is not an oversight — SPEC-019 BR-019-11 needs the wallet's
-- accumulated cost of its allocated shares *after* each historical change,
-- and that figure was never computed or stored anywhere before this column
-- existed. A backfill would have to invent a number for it; `null` says
-- honestly "not known for this event", and the invested-basis growth line
-- legitimately starts at the first event written after this migration lands.
-- The column that consumes it (`core/goals`) is written to treat a `null`
-- here as "no data before this point", never as zero invested.
-- ---------------------------------------------------------------------------