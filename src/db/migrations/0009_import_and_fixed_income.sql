-- SPEC-005 (#8) — B3 extract import, staged rows, and fixed-income
-- contracts extracted from the Posição extract's fixed-income tab.
--
-- `import_batches` is ALTERed (SPEC-006/#6 created it) rather than
-- recreated — four additive columns, expand/contract safe (AR-69/DV-27).
-- `import_rows` and `fixed_income_contracts` are new, both tenant-scoped
-- (AR-14): `user_id`, ENABLE + FORCE row level security, and a
-- `USING`/`WITH CHECK` policy below, in this same migration.
--
-- `import_rows` carries its own `user_id` rather than being scoped through a
-- join to `import_batches` — see `src/db/schema/import-rows.ts` for why.

CREATE TABLE "fixed_income_contracts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"indexer" text,
	"rate" numeric(20, 8),
	"issue_date" date NOT NULL,
	"maturity_date" date,
	"principal" numeric(20, 8),
	"source" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_income_contracts_user_asset_key" UNIQUE("user_id","asset_id"),
	CONSTRAINT "fixed_income_contracts_indexer_check" CHECK ("fixed_income_contracts"."indexer" IS NULL OR "fixed_income_contracts"."indexer" IN ('cdi_percent', 'prefixado', 'ipca_spread'))
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"parsed_payload" jsonb NOT NULL,
	"classification" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"institution_id" uuid,
	"natural_key" text,
	"occurrence" integer,
	"ledger_type" text,
	"transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_rows_classification_check" CHECK ("import_rows"."classification" IN ('new', 'duplicate', 'unclassified', 'invalid', 'position')),
	CONSTRAINT "import_rows_ledger_type_check" CHECK ("import_rows"."ledger_type" IS NULL OR "import_rows"."ledger_type" IN ('buy', 'sell', 'dividend', 'jcp', 'rendimento', 'amortization', 'split', 'grupamento', 'bonificacao', 'subscription', 'transfer_in', 'transfer_out', 'adjustment'))
);
--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "uploaded_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "committed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "row_counts" jsonb;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "reconciliation" jsonb;--> statement-breakpoint
ALTER TABLE "fixed_income_contracts" ADD CONSTRAINT "fixed_income_contracts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_income_contracts" ADD CONSTRAINT "fixed_income_contracts_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_income_contracts" ADD CONSTRAINT "fixed_income_contracts_source_import_batches_id_fk" FOREIGN KEY ("source") REFERENCES "public"."import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fixed_income_contracts_user_id_idx" ON "fixed_income_contracts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "import_rows_user_id_idx" ON "import_rows" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "import_rows_batch_id_idx" ON "import_rows" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "import_rows_user_id_batch_id_idx" ON "import_rows" USING btree ("user_id","batch_id");

-- ---------------------------------------------------------------------------
-- AR-14: the RLS policy for a tenant-scoped table ships in the SAME
-- migration that creates the table. Both tables below are tenant-scoped —
-- `import_batches` already has its policy from #6 and is untouched here.
--
-- FORCE is required in addition to ENABLE, because `allmywallet_migrator`
-- owns these tables and a table owner bypasses its own policies without it.
-- The runtime role `allmywallet_app` is separately NOBYPASSRLS; both
-- mechanisms are used and neither is relied on alone (ARCHITECTURE §5).
--
-- `current_setting('app.user_id')` is called WITHOUT `missing_ok`, so a
-- connection that never ran `withTenant` gets a raised error rather than
-- every tenant's rows back (TS-16). This is the exact template
-- `src/db/rls.ts`'s `tenantIsolationPolicySql` emits.
-- ---------------------------------------------------------------------------

ALTER TABLE "import_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "import_rows" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "import_rows"
	USING      ("user_id" = current_setting('app.user_id')::uuid)
	WITH CHECK ("user_id" = current_setting('app.user_id')::uuid);--> statement-breakpoint

ALTER TABLE "fixed_income_contracts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fixed_income_contracts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fixed_income_contracts"
	USING      ("user_id" = current_setting('app.user_id')::uuid)
	WITH CHECK ("user_id" = current_setting('app.user_id')::uuid);