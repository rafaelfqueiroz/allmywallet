-- SPEC-006 BR-006-05 / SPEC-007 BR-007-05b / #121: represent a non-taxable
-- asset conversion as grouped outgoing and incoming ledger legs. Both columns
-- are nullable and the existing fifteen transaction types must leave them
-- null, so the previous application image can continue reading and writing
-- every row shape it already knows. The personal start script holds conversion
-- writes off until the new image passes health and becomes last-known-good,
-- so rollback never exposes these new type values to the old engine
-- (AR-69/AR-71–75).
--
-- `cost_basis` is exact NUMERIC(20,8), never floating point (AR-06/AR-28).
-- Both directions carry the exact removed/allocated cost so replay conserves
-- NUMERIC(20,8) values at partial-average boundaries. Both legs have zero cash `total_value`. The grouped index
-- starts with `user_id`, matching every tenant query's RLS scope (AR-11).
--
-- No table or policy is created here. `transactions` and `import_rows` retain
-- their existing ENABLE + FORCE RLS and USING + WITH CHECK policies (AR-14).
ALTER TABLE "transactions" ADD COLUMN "conversion_group_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "cost_basis" numeric(20, 8);--> statement-breakpoint
CREATE INDEX "transactions_user_id_conversion_group_id_idx" ON "transactions" USING btree ("user_id","conversion_group_id");--> statement-breakpoint

-- Add and validate before widening the type list. Every existing row takes the
-- non-conversion branch because both new nullable columns were introduced as
-- NULL, so validation neither rewrites nor backfills personal data.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_conversion_pairing_check" CHECK (("transactions"."type" = 'conversion_in'
            AND "transactions"."conversion_group_id" IS NOT NULL
            AND "transactions"."cost_basis" IS NOT NULL
            AND "transactions"."cost_basis" >= 0
            AND "transactions"."total_value" = 0)
          OR ("transactions"."type" = 'conversion_out'
            AND "transactions"."conversion_group_id" IS NOT NULL
            AND "transactions"."cost_basis" IS NOT NULL
            AND "transactions"."cost_basis" >= 0
            AND "transactions"."total_value" = 0)
          OR ("transactions"."type" NOT IN ('conversion_in', 'conversion_out')
            AND "transactions"."conversion_group_id" IS NULL
            AND "transactions"."cost_basis" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "transactions" VALIDATE CONSTRAINT "transactions_conversion_pairing_check";--> statement-breakpoint

-- The generated draft dropped each old CHECK before adding its replacement.
-- Install and validate the wider constraint first instead: there is never a
-- window where an arbitrary type can enter either table, even if the migrator
-- executes statement breakpoints outside a single transaction.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_type_check_v2" CHECK ("transactions"."type" IN ('buy', 'sell', 'dividend', 'jcp', 'rendimento', 'amortization', 'split', 'grupamento', 'bonificacao', 'subscription', 'transfer_in', 'transfer_out', 'adjustment', 'leilao_fracoes', 'fracao_bonificacao', 'conversion_out', 'conversion_in')) NOT VALID;--> statement-breakpoint
ALTER TABLE "transactions" VALIDATE CONSTRAINT "transactions_type_check_v2";--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_type_check";--> statement-breakpoint
ALTER TABLE "transactions" RENAME CONSTRAINT "transactions_type_check_v2" TO "transactions_type_check";--> statement-breakpoint

-- A row CHECK cannot prove a cross-asset event is complete. This deferred
-- constraint trigger observes the final transaction state, so the importer
-- may update a row-backed leg and insert its companion in either order while
-- a singleton, partial delete, or non-conserving group still fails at COMMIT.
CREATE FUNCTION check_asset_conversion_group() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_user uuid;
  affected_group uuid;
  outgoing_count integer;
  incoming_count integer;
  outgoing_cost numeric(20,8);
  incoming_cost numeric(20,8);
BEGIN
  affected_user := COALESCE(NEW.user_id, OLD.user_id);
  FOR affected_group IN
    SELECT DISTINCT group_id
    FROM (VALUES (NEW.conversion_group_id), (OLD.conversion_group_id)) AS groups(group_id)
    WHERE group_id IS NOT NULL
  LOOP
    SELECT
      count(*) FILTER (WHERE type = 'conversion_out'),
      count(*) FILTER (WHERE type = 'conversion_in'),
      COALESCE(sum(cost_basis) FILTER (WHERE type = 'conversion_out'), 0),
      COALESCE(sum(cost_basis) FILTER (WHERE type = 'conversion_in'), 0)
    INTO outgoing_count, incoming_count, outgoing_cost, incoming_cost
    FROM transactions
    WHERE user_id = affected_user AND conversion_group_id = affected_group;

    -- Zero rows means the complete group was deleted, which is valid.
    IF outgoing_count + incoming_count > 0 AND
       (outgoing_count = 0 OR incoming_count = 0 OR outgoing_cost <> incoming_cost) THEN
      RAISE EXCEPTION 'asset conversion group % is incomplete or does not conserve cost', affected_group
        USING ERRCODE = '23514', CONSTRAINT = 'transactions_conversion_group_atomic_check';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER transactions_conversion_group_atomic_check
AFTER INSERT OR UPDATE OR DELETE ON transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_asset_conversion_group();--> statement-breakpoint

ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_ledger_type_check_v2" CHECK ("import_rows"."ledger_type" IS NULL OR "import_rows"."ledger_type" IN ('buy', 'sell', 'dividend', 'jcp', 'rendimento', 'amortization', 'split', 'grupamento', 'bonificacao', 'subscription', 'transfer_in', 'transfer_out', 'adjustment', 'leilao_fracoes', 'fracao_bonificacao', 'conversion_out', 'conversion_in')) NOT VALID;--> statement-breakpoint
ALTER TABLE "import_rows" VALIDATE CONSTRAINT "import_rows_ledger_type_check_v2";--> statement-breakpoint
ALTER TABLE "import_rows" DROP CONSTRAINT "import_rows_ledger_type_check";--> statement-breakpoint
ALTER TABLE "import_rows" RENAME CONSTRAINT "import_rows_ledger_type_check_v2" TO "import_rows_ledger_type_check";
