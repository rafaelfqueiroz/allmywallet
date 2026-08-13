CREATE TABLE "index_series" (
	"code" text NOT NULL,
	"date" date NOT NULL,
	"value" numeric(20, 8) NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "index_series_code_date_pk" PRIMARY KEY("code","date"),
	CONSTRAINT "index_series_code_check" CHECK ("index_series"."code" IN ('CDI', 'IPCA', 'SELIC', 'IBOV'))
);
--> statement-breakpoint
CREATE TABLE "latest_quotes" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"price" numeric(20, 8) NOT NULL,
	"quoted_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_quotes" (
	"asset_id" uuid NOT NULL,
	"date" date NOT NULL,
	"close" numeric(20, 8) NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_quotes_asset_id_date_pk" PRIMARY KEY("asset_id","date")
);
--> statement-breakpoint
CREATE TABLE "quote_budget_usage" (
	"year_month" text NOT NULL,
	"kind" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_budget_usage_year_month_kind_pk" PRIMARY KEY("year_month","kind"),
	CONSTRAINT "quote_budget_usage_kind_check" CHECK ("quote_budget_usage"."kind" IN ('scheduled', 'ondemand'))
);
--> statement-breakpoint
ALTER TABLE "latest_quotes" ADD CONSTRAINT "latest_quotes_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_quotes" ADD CONSTRAINT "price_quotes_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "price_quotes_asset_id_idx" ON "price_quotes" USING btree ("asset_id");