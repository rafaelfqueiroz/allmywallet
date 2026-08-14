-- ---------------------------------------------------------------------------
-- SPEC-009 (#12) — daily valuation snapshots.
--
-- BR-009-16: one row per user per day, holding total value, net contributions,
-- earnings to date and the breakdown by asset class.
--
-- BR-009-17 / DL-009-06: this table is a **derived cache, never authoritative**.
-- Every row is reproducible from `transactions`, `price_quotes` and
-- `index_series`; where it disagrees with a recomputation the ledger wins and
-- this is rebuilt. It exists only for SPEC-016 BR-016-05's report budget —
-- reading a stored snapshot instead of replaying five years of ledger per
-- request.
--
-- AR-69 / DV-27: forward-only and expand/contract safe. This migration only
-- CREATEs; it alters nothing existing, so it is safe against a running
-- previous version — which matters because there is no staging environment
-- (AR-67).
--
-- Numbering note: three specs were implemented in parallel with their numbers
-- assigned up front — #13 wallets -> 0007, #12 valuation -> 0008, #8 import ->
-- 0009 — so that concurrent branches could not both generate the same file.
--
-- This migration and its `meta/0008_snapshot.json` were **regenerated** after
-- 0007_wallets merged, rather than renamed. Drizzle's meta snapshots are
-- cumulative full-schema states, so the copy generated before wallets existed
-- did not contain the wallet tables; the next `drizzle-kit generate` would have
-- diffed against it and re-emitted `CREATE TABLE` for all three into 0009. CI
-- would not have caught that, because CI applies the journal rather than
-- generating from it — the failure would have landed on whoever ran generate
-- next.
-- ---------------------------------------------------------------------------

CREATE TABLE "daily_valuation_snapshots" (
	"user_id" uuid NOT NULL,
	-- AR-29: a date, never a timestamp. "What was it worth on 15 March" is a
	-- date question; a timestamp shifts the answer across a period boundary
	-- depending on the reader's timezone.
	"date" date NOT NULL,
	-- AR-06/AR-28: NUMERIC(20,8) throughout, stored at full precision. AR-09:
	-- rounding happens once, at display, in the i18n formatter — every figure
	-- here is an intermediate for some report, and CR-3 forbids rounding one.
	"total_value" numeric(20, 8) NOT NULL,
	-- External flows only: buys and transfers in, less sells and transfers out.
	-- Not price change, never earnings. SPEC-012's TWR neutralises exactly this
	-- column, which is why it is stored rather than re-derived per report.
	"net_contributions" numeric(20, 8) NOT NULL,
	-- Proventos recognised at pay date (SPEC-014), cumulative to this date.
	"earnings_to_date" numeric(20, 8) NOT NULL,
	-- AR-10: `Money` serialised with `toString()`. A `Decimal` reaching
	-- `JSON.stringify` comes back a float and loses the tail silently, so the
	-- values here are plain decimal strings, written by `serializeSnapshot`.
	"by_asset_class" jsonb NOT NULL,
	-- BR-009-11 / DL-009-02: drives the UI's estimate marker. True when any
	-- component was accrued rather than observed (bank paper priced from its
	-- contracted indexer, or a position that fell back to cost per BR-009-13).
	-- Deliberately NOT set by a carried-forward close (BR-009-03) — that is an
	-- observed price, just an older one, and flagging it would mark every
	-- weekend an estimate.
	"has_estimates" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- BR-009-16, and AR-19's idempotency: a retried `valuation.snapshot` job
	-- upserts on this key rather than appending a second row for the same day,
	-- which would double every total that summed the table.
	CONSTRAINT "daily_valuation_snapshots_user_id_date_pk" PRIMARY KEY("user_id","date"),
	-- This product tracks no liabilities and no margin (the PRD's reason for
	-- "patrimônio" rather than "net worth"), so a negative total is a replay or
	-- pricing defect. Fail at the floor rather than serve it.
	CONSTRAINT "daily_valuation_snapshots_total_non_negative_check" CHECK ("daily_valuation_snapshots"."total_value" >= 0)
);
--> statement-breakpoint
-- AR-27: the cascade is load-bearing for SPEC-004's account deletion.
ALTER TABLE "daily_valuation_snapshots" ADD CONSTRAINT "daily_valuation_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The Portfolio Value chart's access pattern: one tenant, a date range, in
-- order. The primary key already leads with `user_id`, so this serves the
-- range scan rather than the point lookup.
CREATE INDEX "daily_valuation_snapshots_user_id_date_idx" ON "daily_valuation_snapshots" USING btree ("user_id","date");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- AR-14: the RLS policy for a tenant-scoped table ships in the SAME migration
-- that creates the table. A table live for even one deploy without its policy
-- is a table with no isolation, and there is no staging environment to notice.
--
-- `daily_valuation_snapshots` is emphatically tenant data. It is *derived*,
-- which makes it tempting to treat as less sensitive than the ledger it came
-- from — it is not: a single row states exactly what one person's portfolio
-- was worth on one day, and needs no join to be damaging.
--
-- FORCE is required in addition to ENABLE, because `allmywallet_migrator` owns
-- this table and a table owner bypasses its own policies without it. The
-- runtime role `allmywallet_app` is separately NOBYPASSRLS; both mechanisms are
-- used and neither is relied on alone (ARCHITECTURE §5).
--
-- `current_setting('app.user_id')` is called WITHOUT `missing_ok`, deliberately.
-- On a connection that never ran `withTenant` the setting does not exist and the
-- query *raises* rather than returning rows — TS-16's "fails rather than
-- returning everything". This is the exact template `src/db/rls.ts`
-- (`tenantIsolationPolicySql`) emits.
-- ---------------------------------------------------------------------------

ALTER TABLE "daily_valuation_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "daily_valuation_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "daily_valuation_snapshots"
	USING      ("user_id" = current_setting('app.user_id')::uuid)
	WITH CHECK ("user_id" = current_setting('app.user_id')::uuid);
