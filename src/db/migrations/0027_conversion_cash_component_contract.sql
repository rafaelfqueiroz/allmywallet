-- SPEC-007 BR-007-05b / #143 D12/D13: CONTRACT step of 0026's EXPAND
-- (AR-69). Migration 0026 (`0026_conversion_cash_component.sql`, #149)
-- relaxed the pairing CHECK and the group trigger to let a `conversion_out`
-- leg carry a non-negative cash `total_value`, for a return-of-capital
-- reading of B3's priced `Resgate` on the BPFF11 -> RVBI11 incorporation.
-- The owner has since decided that reading was wrong: the one real case was
-- actually a taxable liquidation, not a conversion with a cash component
-- (D10), and it is now stored as a mapped-key sell instead. No code path
-- written since #149 produces a cash-bearing conversion leg — no ledger
-- definition sets a priced redemption field on a conversion leg — so no
-- stored row anywhere has non-zero `total_value` on a conversion leg. This
-- migration removes the capability by tightening the CHECK and the trigger
-- function back to the exact-cost invariant `0023_asset_conversions.sql`
-- first established.
--
-- Safe alongside the previous application image (main at fc8ce7b, #149):
-- that image only ever writes conversion cash through a definition field
-- that no definition sets, so it never attempts to write a non-zero
-- `total_value` on a conversion leg either. It is therefore safe to leave in
-- place if a deploy using it is rolled back to that image (AR-69) — the
-- rolled-back image still cannot produce a row this migration would reject.
--
-- The ADD ... NOT VALID / VALIDATE / DROP / RENAME sequence below is the
-- safety net: VALIDATE scans every existing row under the new, tighter
-- CHECK and fails loudly — not silently corrupts data — if any stored
-- conversion leg actually does carry cash. There is never a window where an
-- arbitrary shape can pass, even across statement breakpoints.
--
-- `cost_basis` and `total_value` remain exact NUMERIC(20,8) (AR-06/AR-28).
--
-- No table or policy is created or altered here. `transactions` retains its
-- existing ENABLE + FORCE RLS and USING + WITH CHECK policy (AR-14).

ALTER TABLE "transactions" ADD CONSTRAINT "transactions_conversion_pairing_check_v2" CHECK (("transactions"."type" = 'conversion_in'
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
ALTER TABLE "transactions" VALIDATE CONSTRAINT "transactions_conversion_pairing_check_v2";--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_conversion_pairing_check";--> statement-breakpoint
ALTER TABLE "transactions" RENAME CONSTRAINT "transactions_conversion_pairing_check_v2" TO "transactions_conversion_pairing_check";--> statement-breakpoint

-- Restore the group-level invariant to `0023_asset_conversions.sql`'s exact
-- form: `sum(cost_basis) out = sum(cost_basis) in`, with no cash term. Every
-- group stored under 0026's function has `sum(total_value) out = 0` (no
-- code writes otherwise), so this is the degenerate case of the relaxed
-- invariant and no existing group is invalidated.
CREATE OR REPLACE FUNCTION check_asset_conversion_group() RETURNS trigger
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
$$;
