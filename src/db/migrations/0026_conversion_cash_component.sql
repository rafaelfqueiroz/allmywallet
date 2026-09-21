-- SPEC-007 BR-007-05b / SPEC-005 BR-005-20c / #143: a conversion group may
-- carry a cash component that B3 states on the outgoing leg — the owner's
-- BPFF11 was incorporated into RVBI11, and each BPFF11 share became 0,9321
-- RVBI11 plus R$ 2,24 in cash, which B3 records as a priced `Resgate` on
-- BPFF11. The owner treats that cash as a return of capital: the
-- `conversion_out` leg removes the source's whole cost basis and carries the
-- cash as `total_value`; the group's `conversion_in` legs then receive
-- removed cost minus cash, so no gain is realised.
--
-- This is an EXPAND: relaxing a CHECK and widening a trigger invariant is
-- strictly permissive — every row and every group `0023_asset_conversions.sql`
-- already accepted (cash always 0) still satisfies both replacements, so the
-- previous application image continues to read and write every row shape it
-- already knows, and the migration is safe to leave in place if a deploy
-- using it is rolled back (AR-69).
--
-- `cost_basis` and `total_value` are exact NUMERIC(20,8), never floating
-- point (AR-06/AR-28).
--
-- No table or policy is created or altered here. `transactions` retains its
-- existing ENABLE + FORCE RLS and USING + WITH CHECK policy (AR-14).

-- Add and validate the wider pairing check before dropping the old one, so
-- there is never a window where an arbitrary shape can pass. `conversion_out`
-- alone gains `total_value >= 0`; `conversion_in` keeps `total_value = 0`,
-- since only the outgoing leg carries B3's priced `Resgate` cash. Every other
-- clause — group id not null, cost_basis not null and >= 0, and non-conversion
-- rows carrying null group and null cost_basis — is unchanged.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_conversion_pairing_check_v2" CHECK (("transactions"."type" = 'conversion_in'
            AND "transactions"."conversion_group_id" IS NOT NULL
            AND "transactions"."cost_basis" IS NOT NULL
            AND "transactions"."cost_basis" >= 0
            AND "transactions"."total_value" = 0)
          OR ("transactions"."type" = 'conversion_out'
            AND "transactions"."conversion_group_id" IS NOT NULL
            AND "transactions"."cost_basis" IS NOT NULL
            AND "transactions"."cost_basis" >= 0
            AND "transactions"."total_value" >= 0)
          OR ("transactions"."type" NOT IN ('conversion_in', 'conversion_out')
            AND "transactions"."conversion_group_id" IS NULL
            AND "transactions"."cost_basis" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "transactions" VALIDATE CONSTRAINT "transactions_conversion_pairing_check_v2";--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_conversion_pairing_check";--> statement-breakpoint
ALTER TABLE "transactions" RENAME CONSTRAINT "transactions_conversion_pairing_check_v2" TO "transactions_conversion_pairing_check";--> statement-breakpoint

-- Widen the group-level invariant the same way the row check widened: the
-- outgoing side's cost may now exceed the incoming side's by exactly the cash
-- the outgoing leg carries. `sum(cost_basis) out = sum(cost_basis) in +
-- sum(total_value) out`. Every group stored under the old function has cash
-- 0 on every row, so `sum(total_value) out = 0` and the old equality is the
-- degenerate case of this one — no existing group is invalidated.
-- `sum(cost_basis) in >= 0` is already implied by the per-row CHECK above
-- (`cost_basis >= 0` on every conversion_in row), restated here for the same
-- reason the row check states it: the invariant should read complete on its
-- own, not rely on a reader having the row CHECK in mind.
CREATE OR REPLACE FUNCTION check_asset_conversion_group() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_user uuid;
  affected_group uuid;
  outgoing_count integer;
  incoming_count integer;
  outgoing_cost numeric(20,8);
  incoming_cost numeric(20,8);
  outgoing_cash numeric(20,8);
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
      COALESCE(sum(cost_basis) FILTER (WHERE type = 'conversion_in'), 0),
      COALESCE(sum(total_value) FILTER (WHERE type = 'conversion_out'), 0)
    INTO outgoing_count, incoming_count, outgoing_cost, incoming_cost, outgoing_cash
    FROM transactions
    WHERE user_id = affected_user AND conversion_group_id = affected_group;

    -- Zero rows means the complete group was deleted, which is valid.
    IF outgoing_count + incoming_count > 0 AND
       (outgoing_count = 0 OR incoming_count = 0
        OR incoming_cost < 0 OR outgoing_cost <> incoming_cost + outgoing_cash) THEN
      RAISE EXCEPTION 'asset conversion group % is incomplete or does not conserve cost', affected_group
        USING ERRCODE = '23514', CONSTRAINT = 'transactions_conversion_group_atomic_check';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
