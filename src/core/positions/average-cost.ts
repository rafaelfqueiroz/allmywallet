import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import { type Result, err, ok } from '@/core/shared/result';
import type { Money, Quantity } from '@/core/shared/money';
import { makePosition, type PositionState } from '@/core/positions/position-state';
import { insufficientQuantity } from '@/core/positions/errors';
import { realizedGainOnSale } from '@/core/positions/realized-gain';

/**
 * SPEC-007 §Average cost — BR-007-01: cost basis is a **moving weighted
 * average**, the Brazilian convention and what Receita Federal expects. Not
 * FIFO, not LIFO, not specific-lot (DL-007-01), and not configurable
 * (DL-007-05).
 *
 * AR-09: nothing here rounds. The only division is the one that produces the
 * average itself, and it terminates at `Money`'s 40 significant digits — 12
 * more than `NUMERIC(20,8)` can hold, so the truncation cannot reach a digit
 * that is ever stored or shown.
 */

export interface AcquisitionInput {
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly fees: Money;
}

export interface DisposalInput {
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly fees: Money;
  readonly date: BusinessDate;
}

/**
 * SPEC-007 BR-007-02 — **Buy:**
 * `new average = (existing qty × existing average + purchase qty × purchase
 * price + fees) ÷ total qty`. Fees increase cost basis.
 *
 * Implemented against `totalCost` rather than by re-expanding
 * `existing qty × existing average`, which is the same number without a
 * round trip through a truncated division.
 *
 * Worked example (DV-17) — the AC "average cost after a sequence of buys
 * matches a hand-computed weighted average":
 *
 *   Buy 100 PETR4 @ 30,00, fees 5,00
 *     total cost = 100 × 30,00 + 5,00      = 3.005,00
 *     average    = 3.005,00 ÷ 100          =    30,05
 *   Buy 50 more  @ 36,00, fees 4,00
 *     total cost = 3.005,00 + 1.800,00 + 4,00 = 4.809,00
 *     average    = 4.809,00 ÷ 150             =    32,06
 *
 * Note the average is *not* the mean of 30,05 and 36,08 — weighting by
 * quantity is the whole point, and the fee-inclusive figure is what the
 * broker statement shows.
 *
 * BR-007-06 (subscription) and a `transfer_in` use this same handler: a
 * subscription is a buy at the subscription price, and shares arriving from
 * another institution arrive carrying the cost the source ledger recorded.
 */
export function applyAcquisition(state: PositionState, input: AcquisitionInput): PositionState {
  const addedCost = input.unitPrice.times(input.quantity).plus(input.fees);
  return makePosition(
    state.quantity.plus(input.quantity),
    state.totalCost.plus(addedCost),
    state.realizedGain,
  );
}

/**
 * SPEC-007 BR-007-03 — **Sell:** quantity decreases; **average cost is
 * unchanged**. Sales never alter cost basis (DL-007-03).
 *
 * The average is *carried forward literally* rather than recomputed from the
 * reduced total cost. Algebraically the two agree; numerically, recomputing
 * would land one truncation away from the figure the user last saw, and this
 * is precisely the number they compare against a broker statement.
 *
 * BR-007-09: `realized gain = (sale price − average cost at sale date) ×
 * quantity sold − fees`, on an average-cost basis, never FIFO (BR-007-10).
 * BR-007-11: it is computed here, at the moment of sale, from the average then
 * in force — a later purchase changes the average going forward and does not
 * restate this figure.
 *
 * Worked example (DV-17), continuing the position built above — the AC
 * "realized gain on a partial sale uses the average cost at sale date":
 *
 *   Holding   150 @ 32,06   (total cost 4.809,00)
 *   Sell       40 @ 40,00, fees 3,50
 *     realized = (40,00 − 32,06) × 40 − 3,50 = 317,60 − 3,50 = 314,10
 *     quantity = 150 − 40                                    = 110
 *     average  =                                                32,06  ← unchanged
 *     total    = 4.809,00 − 32,06 × 40 = 4.809,00 − 1.282,40  = 3.526,60
 *     check    = 3.526,60 ÷ 110                               = 32,06  ✓
 */
export function applySale(
  state: PositionState,
  input: DisposalInput,
): Result<PositionState, DomainError> {
  const removal = removeQuantity(state, input.quantity, input.date);
  if (!removal.ok) return removal;

  const gain = realizedGainOnSale({
    unitPrice: input.unitPrice,
    averageCost: state.averageCost,
    quantity: input.quantity,
    fees: input.fees,
  });

  return ok(
    makePosition(
      removal.value.quantity,
      removal.value.totalCost,
      state.realizedGain.plus(gain),
      state.averageCost,
    ),
  );
}

/**
 * A quantity leaving the position **without** a disposal: a `transfer_out` to
 * another institution, or a negative reconciliation `adjustment`.
 *
 * Deliberately not a sale. Moving shares between custodians is not a
 * disposal — realising a gain on one would put a number in the user's realized
 * total that Receita Federal never asked for and the broker never reported.
 * The cost leaves with the shares at average cost, so the average is unchanged
 * exactly as in BR-007-03.
 */
export function applyWithdrawal(
  state: PositionState,
  quantity: Quantity,
  date: BusinessDate,
): Result<PositionState, DomainError> {
  const removal = removeQuantity(state, quantity, date);
  if (!removal.ok) return removal;
  return ok(
    makePosition(
      removal.value.quantity,
      removal.value.totalCost,
      state.realizedGain,
      state.averageCost,
    ),
  );
}

/**
 * The shared guard and arithmetic behind both routes out of a position.
 *
 * SPEC-006 BR-006-15: an attempt to remove more than is held is refused with
 * the held quantity in the error, never clamped to zero. Clamping would let a
 * corrupt ledger produce a plausible-looking position, which is the failure
 * mode this whole engine is built to avoid.
 *
 * Removing at average cost is what leaves the average untouched:
 * `(totalCost − average × sold) ÷ (qty − sold)` = `average`. When the position
 * closes completely, `makePosition` resets it (BR-007-07) and the ~1e-40
 * residue that a truncated average leaves behind goes with it.
 */
function removeQuantity(
  state: PositionState,
  quantity: Quantity,
  date: BusinessDate,
): Result<{ quantity: Quantity; totalCost: Money }, DomainError> {
  const remaining = state.quantity.minus(quantity);
  if (remaining.isNegative()) {
    return err(insufficientQuantity(state.quantity, quantity, date));
  }
  return ok({
    quantity: remaining,
    totalCost: state.totalCost.minus(state.averageCost.times(quantity)),
  });
}
