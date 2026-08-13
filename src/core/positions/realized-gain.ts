import type { Money, Quantity } from '@/core/shared/money';

/**
 * SPEC-007 §Realized gain.
 *
 * Kept in its own file rather than inlined into the sale handler because it is
 * the figure a user carries into a tax return: BR-007-09 is one line of
 * arithmetic that has to be findable, citable and testable on its own.
 */

export interface RealizedGainInput {
  /** The price the shares actually sold at. */
  readonly unitPrice: Money;
  /**
   * BR-007-11: the average **at the sale date**, in force at that moment.
   * A purchase made afterwards raises the average going forward and does not
   * restate this figure — the caller passes the pre-sale average, never a
   * recomputed one.
   */
  readonly averageCost: Money;
  readonly quantity: Quantity;
  /** Sale fees reduce the gain (SPEC-007 AC "sale fees reduce realized gain"). */
  readonly fees: Money;
}

/**
 * SPEC-007 BR-007-09:
 * `realized gain = (sale price − average cost at sale date) × quantity sold − fees`
 *
 * BR-007-10: average-cost basis, explicitly **not** FIFO. FIFO is common in
 * other jurisdictions and would produce a figure contradicting what the user
 * must actually report here (DL-007-02).
 *
 * Worked example (DV-17), a loss — the sign is not incidental, a realized
 * loss offsets gains in the same month for Brazilian tax purposes:
 *
 *   Average 32,06, sell 40 @ 28,00, fees 3,50
 *     (28,00 − 32,06) × 40 − 3,50 = −162,40 − 3,50 = −165,90
 *
 * Note the fee subtracts in both directions: it deepens a loss just as it
 * shaves a gain, because it is money that left the account either way.
 */
export function realizedGainOnSale(input: RealizedGainInput): Money {
  return input.unitPrice.minus(input.averageCost).times(input.quantity).minus(input.fees);
}
