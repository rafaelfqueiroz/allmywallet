import { Money, Quantity } from '@/core/shared/money';

/**
 * SPEC-007 — the state a position replay folds over.
 *
 * Four fields, not three, and the reason matters. `totalCost` and
 * `averageCost` are *both* stored rather than one being derived from the
 * other, because the spec's rules pin them independently:
 *
 *   - BR-007-04 (split) fixes **total cost** and lets the average move;
 *   - BR-007-03 (sell)  fixes the **average** and lets total cost move.
 *
 * Deriving either one from the other would make one of those two rules hold
 * only to within a division's truncation. Storing both lets each rule be
 * implemented literally, which is what a user reconciling a *preço médio*
 * against a broker statement is actually checking.
 *
 * DV-06: immutable. Every handler returns a new state.
 */
export interface PositionState {
  /** Shares, quotas or units held. Never negative — disposals are guarded. */
  readonly quantity: Quantity;
  /** Accumulated acquisition cost of the open lot, fees included (BR-007-02). */
  readonly totalCost: Money;
  /** *Preço médio*. Zero when the position is flat — see `makePosition`. */
  readonly averageCost: Money;
  /** Cumulative realized gain, net of sale fees (BR-007-09). Can be negative. */
  readonly realizedGain: Money;
}

/**
 * The empty position: no lot open, nothing realized. Also what a position
 * resets to when it closes (BR-007-07).
 */
export const EMPTY_POSITION: PositionState = {
  quantity: Quantity.zero(),
  totalCost: Money.zero(),
  averageCost: Money.zero(),
  realizedGain: Money.zero(),
};

/**
 * The single constructor for a `PositionState`, and the single place
 * BR-007-07 is enforced.
 *
 * SPEC-007 BR-007-07: a position fully closed then reopened starts a new lot —
 * the average resets and no residual cost carries over. Enforcing that here
 * rather than in each handler means every route to zero (a sale, a transfer
 * out, a negative adjustment) resets identically, and none can be forgotten.
 *
 * It also annihilates the only place truncation could otherwise accumulate.
 * A full disposal computes `totalCost − average × quantitySold`; because
 * `average` is a division truncated at 40 significant digits, that residue is
 * around 1e-40 of the position rather than exactly zero. Collapsing to a
 * literal zero here is not cosmetic — it is what stops a re-entry inheriting a
 * phantom cost from a lot the user has closed.
 *
 * `explicitAverage` exists for BR-007-03: a sale must leave the average
 * *unchanged*, which means carrying the previous value forward rather than
 * recomputing `totalCost / quantity` and landing a truncation away from it.
 */
export function makePosition(
  quantity: Quantity,
  totalCost: Money,
  realizedGain: Money,
  explicitAverage?: Money,
): PositionState {
  if (quantity.isZero()) {
    return {
      quantity: Quantity.zero(),
      totalCost: Money.zero(),
      averageCost: Money.zero(),
      realizedGain,
    };
  }
  return {
    quantity,
    totalCost,
    averageCost: explicitAverage ?? totalCost.dividedBy(quantity),
    realizedGain,
  };
}

/**
 * Exact structural equality, used by the rebuild-equals-incremental gate
 * (DM-4 / TS-08). Compares the decimal *values*, not object identity — two
 * states reached by different routes are equal when every figure agrees.
 */
export function positionsEqual(a: PositionState, b: PositionState): boolean {
  return (
    a.quantity.equals(b.quantity) &&
    a.totalCost.equals(b.totalCost) &&
    a.averageCost.equals(b.averageCost) &&
    a.realizedGain.equals(b.realizedGain)
  );
}

/**
 * AR-10: the serialisation boundary. A `Decimal` reaching `JSON.stringify`
 * comes back a float, so anything crossing a job payload, a server-action
 * return or a test snapshot goes through this instead.
 */
export interface SerializedPosition {
  readonly quantity: string;
  readonly totalCost: string;
  readonly averageCost: string;
  readonly realizedGain: string;
}

export function serializePosition(state: PositionState): SerializedPosition {
  return {
    quantity: state.quantity.toString(),
    totalCost: state.totalCost.toString(),
    averageCost: state.averageCost.toString(),
    realizedGain: state.realizedGain.toString(),
  };
}
