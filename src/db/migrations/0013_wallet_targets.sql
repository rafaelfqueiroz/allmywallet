CREATE TABLE "wallet_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"target_pct" numeric(20, 8) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_targets_wallet_id_asset_id_key" UNIQUE("wallet_id","asset_id"),
	CONSTRAINT "wallet_targets_target_pct_range_check" CHECK ("wallet_targets"."target_pct" >= 0 AND "wallet_targets"."target_pct" <= 100)
);
--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "target_mode" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_targets" ADD CONSTRAINT "wallet_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_targets" ADD CONSTRAINT "wallet_targets_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_targets" ADD CONSTRAINT "wallet_targets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_targets_user_id_wallet_id_idx" ON "wallet_targets" USING btree ("user_id","wallet_id");--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_target_mode_check" CHECK ("wallets"."target_mode" IN ('none', 'equal_weight', 'manual'));

-- ---------------------------------------------------------------------------
-- AR-14: the RLS policy ships in the SAME migration that creates the table.
--
-- `wallet_targets` states the proportions one person intends to hold — as
-- personal as `wallet_allocations`, which states what they actually hold. A
-- table live for a single deploy without its policy is a table with no
-- isolation.
--
-- FORCE as well as ENABLE: `allmywallet_migrator` owns the table and a table
-- owner bypasses its own policies without it. `current_setting('app.user_id')`
-- is called WITHOUT `missing_ok`, so a connection that never ran `withTenant`
-- raises rather than returning every tenant's rows (TS-16).
-- ---------------------------------------------------------------------------

ALTER TABLE "wallet_targets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallet_targets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "wallet_targets"
	USING      ("user_id" = current_setting('app.user_id')::uuid)
	WITH CHECK ("user_id" = current_setting('app.user_id')::uuid);

-- ---------------------------------------------------------------------------
-- `wallets.target_mode` needs no backfill and takes none.
--
-- The column lands NOT NULL DEFAULT 'none', so every wallet that existed
-- before this migration reads as "no targets defined" — which is exactly
-- BR-017-01: a wallet without targets behaves as it did. Expand/contract safe
-- (AR-69): the default means a deploy still running the previous code inserts
-- rows that satisfy the constraint without knowing the column exists.
-- ---------------------------------------------------------------------------
