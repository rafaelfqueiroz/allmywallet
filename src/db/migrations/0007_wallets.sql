CREATE TABLE "wallet_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"quantity" numeric(20, 8) NOT NULL,
	"cost_basis_at_allocation" numeric(20, 8),
	"allocated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_allocations_user_wallet_asset_key" UNIQUE("user_id","wallet_id","asset_id"),
	CONSTRAINT "wallet_allocations_quantity_positive_check" CHECK ("wallet_allocations"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "wallet_asset_rules" (
	"user_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_asset_rules_user_id_asset_id_pk" PRIMARY KEY("user_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"goal" text,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_allocations" ADD CONSTRAINT "wallet_allocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_allocations" ADD CONSTRAINT "wallet_allocations_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_allocations" ADD CONSTRAINT "wallet_allocations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_asset_rules" ADD CONSTRAINT "wallet_asset_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_asset_rules" ADD CONSTRAINT "wallet_asset_rules_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_asset_rules" ADD CONSTRAINT "wallet_asset_rules_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_allocations_user_id_idx" ON "wallet_allocations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "wallet_allocations_user_id_asset_id_idx" ON "wallet_allocations" USING btree ("user_id","asset_id");--> statement-breakpoint
CREATE INDEX "wallet_allocations_wallet_id_idx" ON "wallet_allocations" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "wallet_asset_rules_user_id_idx" ON "wallet_asset_rules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "wallet_asset_rules_wallet_id_idx" ON "wallet_asset_rules" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "wallets_user_id_idx" ON "wallets" USING btree ("user_id");

-- ---------------------------------------------------------------------------
-- AR-14: the RLS policy for a tenant-scoped table ships in the SAME migration
-- that creates the table. All three tables above are tenant-scoped — there is
-- no shared/reference table introduced by this migration.
--
-- FORCE is required in addition to ENABLE, because `allmywallet_migrator` owns
-- these tables and a table owner bypasses its own policies without it. The
-- runtime role `allmywallet_app` is separately NOBYPASSRLS; both mechanisms
-- are used and neither is relied on alone (ARCHITECTURE §5).
--
-- `current_setting('app.user_id')` is called WITHOUT `missing_ok`, so a
-- connection that never ran `withTenant` gets a raised error rather than
-- every tenant's rows back (TS-16). This is the exact template
-- `src/db/rls.ts`'s `tenantIsolationPolicySql` emits.
-- ---------------------------------------------------------------------------

ALTER TABLE "wallets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "wallets"
	USING      ("user_id" = current_setting('app.user_id')::uuid)
	WITH CHECK ("user_id" = current_setting('app.user_id')::uuid);--> statement-breakpoint

ALTER TABLE "wallet_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallet_allocations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "wallet_allocations"
	USING      ("user_id" = current_setting('app.user_id')::uuid)
	WITH CHECK ("user_id" = current_setting('app.user_id')::uuid);--> statement-breakpoint

ALTER TABLE "wallet_asset_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallet_asset_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "wallet_asset_rules"
	USING      ("user_id" = current_setting('app.user_id')::uuid)
	WITH CHECK ("user_id" = current_setting('app.user_id')::uuid);

-- ---------------------------------------------------------------------------
-- BR-010-05: the sum invariant — total allocated quantity per (user, asset)
-- never exceeds the quantity held — is NOT enforced by this schema. It spans
-- rows of wallet_allocations (a sum) against a figure that lives in a
-- different table entirely (positions.quantity), which Postgres has no
-- row-level CHECK to express. It is enforced in application code: every
-- write path takes `SELECT ... FOR UPDATE` over the asset's allocation rows
-- inside the same `withTenant` transaction as the write that follows
-- (src/adapters/db/wallet-repository.ts, src/core/wallets/ports.ts). See
-- src/db/schema/wallets.ts for the full explanation and
-- tests/integration/wallet-allocation-invariant.test.ts for the proof under
-- concurrent writes.
-- ---------------------------------------------------------------------------
