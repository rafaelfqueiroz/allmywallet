-- SPEC-021 BR-021-31: a close worker-start catch-up could not recover is
-- recorded, never interpolated and never carried forward as though observed.
--
-- AR-15: a shared reference table, declared in src/db/shared-tables.ts — keyed
-- exactly like price_quotes, no user column, nothing personal, so no RLS
-- policy (AR-14 applies to tenant tables). allmywallet_app's DML grant comes
-- from 0000_roles.sql's ALTER DEFAULT PRIVILEGES, as for every table since.
--
-- AR-69 expand-only: a new table nothing existing reads. The previous image
-- runs unchanged on this schema, and rolling back to it leaves the table
-- unused, not broken.
CREATE TABLE "price_quote_gaps" (
	"asset_id" uuid NOT NULL,
	"date" date NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_quote_gaps_asset_id_date_pk" PRIMARY KEY("asset_id","date"),
	CONSTRAINT "price_quote_gaps_reason_check" CHECK ("price_quote_gaps"."reason" IN ('provider_unavailable', 'not_supplied', 'budget_exhausted'))
);
--> statement-breakpoint
ALTER TABLE "price_quote_gaps" ADD CONSTRAINT "price_quote_gaps_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "price_quote_gaps_date_idx" ON "price_quote_gaps" USING btree ("date");
