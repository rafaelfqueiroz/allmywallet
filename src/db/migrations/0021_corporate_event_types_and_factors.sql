-- SPEC-006 BR-006-05 (amended, #113): two new TransactionType members —
-- `leilao_fracoes` (the cash for a bonificação fraction sold at auction, a
-- fifth provento type — SPEC-014 BR-014-01) and `fracao_bonificacao` (a
-- bonificação fraction B3 removed — quantity leaves at unchanged total cost,
-- SPEC-007 BR-007-05a). Both CHECKs only widen their allowed-values list.
--
-- AR-69 expand-only: the previous application image reads neither new value
-- — its `TransactionType` union still has thirteen members, so it never
-- writes one and never has to interpret one it reads. No row of either type
-- exists anywhere until a re-import runs against PR-A's image, which is
-- live (and last-known-good, per the issue's PR-A/PR-B gate) before that
-- re-import happens. A rollback to the previous image after this migration
-- is therefore safe: it leaves the widened CHECK in place, unused, exactly
-- like every prior widening in this file's lineage (0016, 0019).
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_type_check";--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_type_check" CHECK ("transactions"."type" IN ('buy', 'sell', 'dividend', 'jcp', 'rendimento', 'amortization', 'split', 'grupamento', 'bonificacao', 'subscription', 'transfer_in', 'transfer_out', 'adjustment', 'leilao_fracoes', 'fracao_bonificacao'));--> statement-breakpoint
ALTER TABLE "import_rows" DROP CONSTRAINT "import_rows_ledger_type_check";--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_ledger_type_check" CHECK ("import_rows"."ledger_type" IS NULL OR "import_rows"."ledger_type" IN ('buy', 'sell', 'dividend', 'jcp', 'rendimento', 'amortization', 'split', 'grupamento', 'bonificacao', 'subscription', 'transfer_in', 'transfer_out', 'adjustment', 'leilao_fracoes', 'fracao_bonificacao'));--> statement-breakpoint
-- SPEC-008 BR-008-29 (#113): B3's published corporate-event factor — "no key,
-- no credential, no user data sent", "persisted and shared across tenants
-- like quotes (BR-008-25)". Two tables, both shared reference data, declared
-- in src/db/shared-tables.ts and reviewed there (SPEC-003 BR-003-06/AR-15) —
-- **deliberately no `user_id`, no RLS**. AR-14 requires a policy in the same
-- migration as a *tenant* table; these are not tenant tables, which is why
-- there is no policy here rather than a forgotten one.
--
-- AR-69 expand-only: two new tables nothing existing reads yet. The previous
-- image runs unchanged against this schema, and a rollback to it leaves both
-- tables present and unused, not broken — same shape as `price_quote_gaps`
-- (0017) and `backup_runs` (0018).
--
-- `factor_published` is `text`, not `NUMERIC(20,8)` via the `rate` custom
-- type: B3 states some factors at more than eight decimal places, which an
-- 8-decimal-place column would silently truncate. The verbatim `.`-decimal
-- string is the value stored here; it is parsed to `Quantity` only in the
-- repository that reads it (PR-B's `core/positions/share-ratio.ts`).
--
-- `allmywallet_app`'s SELECT/INSERT/UPDATE/DELETE grant on both tables comes
-- from 0000_roles.sql's `ALTER DEFAULT PRIVILEGES FOR ROLE allmywallet_migrator`
-- — automatic for every table this role creates, same as every table since.
-- Granting it explicitly here would duplicate that default, not strengthen
-- it, and `allmywallet_app` is not, and must never become, BYPASSRLS or the
-- table owner (ARCHITECTURE §5) — RLS's absence here is a deliberate
-- declaration, not a gap the app role's privileges happen to paper over.
CREATE TABLE "corporate_event_factors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"issuer_code" text NOT NULL,
	"kind" text NOT NULL,
	"factor_published" text NOT NULL,
	"last_date_prior" date NOT NULL,
	"approved_on" date,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corporate_event_factors_issuer_kind_date_factor_key" UNIQUE("issuer_code","kind","last_date_prior","factor_published"),
	CONSTRAINT "corporate_event_factors_kind_check" CHECK ("corporate_event_factors"."kind" IN ('desdobramento', 'grupamento', 'bonificacao'))
);
--> statement-breakpoint
CREATE INDEX "corporate_event_factors_issuer_code_idx" ON "corporate_event_factors" USING btree ("issuer_code");--> statement-breakpoint
-- One row per issuer: the outcome of the last attempt to fetch its factor set
-- (PR-B's `adapters/market-data/b3-listed-companies.ts`), so a refresh cadence
-- (7 days, or immediately on failure — a config-registry key, not a constant)
-- can be read without scanning `corporate_event_factors` for a max date. An
-- outage leaves rows in `corporate_event_factors` unconfirmed; it never fails
-- a commit (BR-008-29).
CREATE TABLE "corporate_event_factor_fetches" (
	"issuer_code" text PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corporate_event_factor_fetches_outcome_check" CHECK ("corporate_event_factor_fetches"."outcome" IN ('ok', 'not_listed', 'failed'))
);
