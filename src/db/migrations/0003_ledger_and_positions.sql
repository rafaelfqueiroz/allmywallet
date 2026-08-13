CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"class" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_code_unique" UNIQUE("code"),
	CONSTRAINT "assets_class_check" CHECK ("assets"."class" IN ('stock', 'fii', 'bdr', 'etf', 'tesouro_direto', 'cdb', 'lci', 'lca'))
);
--> statement-breakpoint
CREATE TABLE "institutions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institutions_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batches_source_check" CHECK ("import_batches"."source" IN ('b3_movimentacao', 'b3_negociacao', 'b3_posicao', 'manual')),
	CONSTRAINT "import_batches_status_check" CHECK ("import_batches"."status" IN ('pending', 'previewed', 'committed', 'discarded'))
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"institution_id" uuid,
	"type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"trade_date" date NOT NULL,
	"quantity" numeric(20, 8) NOT NULL,
	"unit_price" numeric(20, 8) NOT NULL,
	"fees" numeric(20, 8) NOT NULL,
	"total_value" numeric(20, 8) NOT NULL,
	"ratio" numeric(20, 8),
	"natural_key" text NOT NULL,
	"occurrence" integer DEFAULT 1 NOT NULL,
	"import_batch_id" uuid,
	"is_manual" boolean DEFAULT false NOT NULL,
	"is_user_modified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_user_natural_key_occurrence_key" UNIQUE("user_id","natural_key","occurrence"),
	CONSTRAINT "transactions_type_check" CHECK ("transactions"."type" IN ('buy', 'sell', 'dividend', 'jcp', 'rendimento', 'amortization', 'split', 'grupamento', 'bonificacao', 'subscription', 'transfer_in', 'transfer_out', 'adjustment')),
	CONSTRAINT "transactions_status_check" CHECK ("transactions"."status" IN ('active', 'unclassified', 'superseded')),
	CONSTRAINT "transactions_ratio_pairing_check" CHECK (("transactions"."type" IN ('split', 'grupamento') AND "transactions"."ratio" IS NOT NULL AND "transactions"."ratio" > 0)
          OR ("transactions"."type" NOT IN ('split', 'grupamento') AND "transactions"."ratio" IS NULL)),
	CONSTRAINT "transactions_fees_non_negative_check" CHECK ("transactions"."fees" >= 0),
	CONSTRAINT "transactions_unit_price_non_negative_check" CHECK ("transactions"."unit_price" >= 0),
	CONSTRAINT "transactions_occurrence_positive_check" CHECK ("transactions"."occurrence" >= 1)
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"institution_id" uuid,
	"quantity" numeric(20, 8) NOT NULL,
	"average_cost" numeric(20, 8) NOT NULL,
	"total_cost" numeric(20, 8) NOT NULL,
	"realized_gain" numeric(20, 8) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_user_asset_institution_key" UNIQUE NULLS NOT DISTINCT("user_id","asset_id","institution_id"),
	CONSTRAINT "positions_quantity_non_negative_check" CHECK ("positions"."quantity" >= 0),
	CONSTRAINT "positions_closed_reset_check" CHECK ("positions"."quantity" > 0 OR ("positions"."total_cost" = 0 AND "positions"."average_cost" = 0))
);
--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_name_idx" ON "assets" USING btree ("name");--> statement-breakpoint
CREATE INDEX "assets_class_idx" ON "assets" USING btree ("class");--> statement-breakpoint
CREATE INDEX "import_batches_user_id_idx" ON "import_batches" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transactions_user_id_trade_date_idx" ON "transactions" USING btree ("user_id","trade_date");--> statement-breakpoint
CREATE INDEX "transactions_user_asset_institution_idx" ON "transactions" USING btree ("user_id","asset_id","institution_id","trade_date");--> statement-breakpoint
CREATE INDEX "transactions_user_id_asset_id_trade_date_idx" ON "transactions" USING btree ("user_id","asset_id","trade_date");--> statement-breakpoint
CREATE INDEX "positions_user_id_idx" ON "positions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "positions_user_id_asset_id_idx" ON "positions" USING btree ("user_id","asset_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- AR-14: the RLS policy for a tenant-scoped table ships in the SAME migration
-- that creates the table. A table live for even one deploy without its policy
-- is a table with no isolation, and there is no staging environment to notice
-- (AR-67).
--
-- Three tenant tables are created above — `import_batches`, `transactions` and
-- `positions`. `assets` and `institutions` are declared-shared reference data
-- (AR-15 / SPEC-003 BR-003-06, listed in src/db/shared-tables.ts): they hold
-- no personal data, carry no `user_id`, and are read across tenants by design.
--
-- FORCE is required in addition to ENABLE, because `allmywallet_migrator` owns
-- these tables and a table owner bypasses its own policies without it. The
-- runtime role `allmywallet_app` is separately NOBYPASSRLS; both mechanisms are
-- used and neither is relied on alone (ARCHITECTURE §5).
--
-- `current_setting('app.user_id')` is called WITHOUT `missing_ok`, deliberately.
-- On a connection that never ran `withTenant` the setting does not exist and the
-- query *raises* rather than returning rows — TS-16's "fails rather than
-- returning everything". This is the exact template `src/db/rls.ts`
-- (`tenantIsolationPolicySql`) emits, so a future table cannot drift from it.
-- ---------------------------------------------------------------------------

ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "import_batches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "import_batches"
	USING      ("user_id" = current_setting('app.user_id')::uuid)
	WITH CHECK ("user_id" = current_setting('app.user_id')::uuid);--> statement-breakpoint

ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "transactions"
	USING      ("user_id" = current_setting('app.user_id')::uuid)
	WITH CHECK ("user_id" = current_setting('app.user_id')::uuid);--> statement-breakpoint

ALTER TABLE "positions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "positions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "positions"
	USING      ("user_id" = current_setting('app.user_id')::uuid)
	WITH CHECK ("user_id" = current_setting('app.user_id')::uuid);
