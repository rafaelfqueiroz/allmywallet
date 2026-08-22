CREATE TABLE "wallet_allocation_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"quantity" numeric(20, 8) NOT NULL,
	"effective_on" date NOT NULL,
	"cause" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_allocation_events_quantity_not_negative_check" CHECK ("wallet_allocation_events"."quantity" >= 0),
	CONSTRAINT "wallet_allocation_events_cause_check" CHECK ("wallet_allocation_events"."cause" IN ('assignment', 'buy', 'sale', 'corporate_event', 'wallet_deleted', 'backfill'))
);
--> statement-breakpoint
ALTER TABLE "wallet_allocation_events" ADD CONSTRAINT "wallet_allocation_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_allocation_events" ADD CONSTRAINT "wallet_allocation_events_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_allocation_events_user_id_effective_on_idx" ON "wallet_allocation_events" USING btree ("user_id","effective_on");--> statement-breakpoint
CREATE INDEX "wallet_allocation_events_user_id_asset_id_idx" ON "wallet_allocation_events" USING btree ("user_id","asset_id");

-- ---------------------------------------------------------------------------
-- AR-14: the RLS policy ships in the SAME migration that creates the table.
-- `wallet_allocation_events` states what one tenant's wallets held and when —
-- a table live for a single deploy without its policy is a table with no
-- isolation.
--
-- FORCE as well as ENABLE: `allmywallet_migrator` owns the table and a table
-- owner bypasses its own policies without it. `current_setting('app.user_id')`
-- is called WITHOUT `missing_ok`, so a connection that never ran `withTenant`
-- raises rather than returning every tenant's rows (TS-16).
-- ---------------------------------------------------------------------------

ALTER TABLE "wallet_allocation_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallet_allocation_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "wallet_allocation_events"
	USING      ("user_id" = current_setting('app.user_id')::uuid)
	WITH CHECK ("user_id" = current_setting('app.user_id')::uuid);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- BACKFILL — one event per allocation that already exists.
--
-- Without it every allocation made before this migration is invisible to the
-- fold, and SPEC-014's wallet income would read zero for every period before
-- today: a report that is not merely incomplete but *wrong in a plausible
-- direction*, which is worse.
--
-- `allocated_at` is when the allocation was first made and is the best
-- evidence available; `created_at` covers the rows where it is null (DM-2
-- allows that — a row scaled by a corporate event or reduced by a sale may
-- never have carried one). Converted in São Paulo, because AR-29's business
-- date is the local one and a UTC cast would move a late-evening allocation
-- to the following day.
--
-- Deliberately **not** an attempt to reconstruct true history: it records that
-- the current quantity was allocated from that date, which is exactly as much
-- as the database knows. Everything after this migration is recorded as it
-- happens. `cause = 'backfill'` marks the difference so a figure that looks
-- wrong can be traced to the estimate rather than to the log.
-- ---------------------------------------------------------------------------

INSERT INTO "wallet_allocation_events"
	("id", "user_id", "wallet_id", "asset_id", "quantity", "effective_on", "cause")
SELECT
	gen_random_uuid(),
	"user_id",
	"wallet_id",
	"asset_id",
	"quantity",
	(COALESCE("allocated_at", "created_at") AT TIME ZONE 'America/Sao_Paulo')::date,
	'backfill'
FROM "wallet_allocations";

