import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import { type Result, err, ok } from '@/core/shared/result';
import type { Quantity } from '@/core/shared/money';
import { makePosition, type PositionState } from '@/core/positions/position-state';
import { invalidEventRatio } from '@/core/positions/errors';
import { applyAcquisition, type AcquisitionInput } from '@/core/positions/average-cost';

/**
 * SPEC-007 — corporate events. The part of the engine that is not obvious six
 * months later, which is why every handler here carries a worked example
 * (DV-17).
 *
 * The unifying idea: **a split, a grupamento and a bonificação all change how
 * many pieces the same money is divided into.** Total cost is the invariant;
 * quantity and the average move around it. A handler that instead adjusted the
 * average directly and let total cost fall out would drift, because the
 * average is the divided figure and dividing twice compounds the truncation.
 */

/**
 * SPEC-007 BR-007-04 — **Split / grupamento:** quantity adjusts by the ratio;
 * total cost unchanged; average cost adjusts inversely.
 *
 * The ratio is the multiplier applied to quantity, read straight off the
 * event's Brazilian description:
 *
 *   - *desdobramento* 1:2 — each 1 share becomes 2  → ratio **2**
 *   - *desdobramento* 1:10                          → ratio **10**
 *   - *grupamento* 10:1  — each 10 become 1         → ratio **0,1**
 *
 * Worked example (DV-17), the AC "a 1:2 split doubles quantity, halves average
 * cost, and leaves total cost unchanged":
 *
 *   Before  100 shares, average 10,00, total cost 1.000,00
 *   Split ×2
 *   After   200 shares, total cost 1.000,00  ← unchanged, no money moved
 *           average = 1.000,00 ÷ 200 = 5,00  ← halved
 *
 * And the inverse (AC "a grupamento does the inverse"), *grupamento* 10:1:
 *
 *   Before  100 shares, average 10,00, total cost 1.000,00
 *   Grupamento ×0,1
 *   After    10 shares, total cost 1.000,00
 *           average = 1.000,00 ÷ 10 = 100,00
 *
 * A ratio of zero or less is refused rather than applied: it would erase or
 * invert a position, and the only way to get one is a bad event feed.
 * Applying the event to a flat position is a no-op, not an error — a corporate
 * action on an asset the user does not hold legitimately changes nothing.
 */
export function applyShareRatioEvent(
  state: PositionState,
  ratio: Quantity,
  date: BusinessDate,
): Result<PositionState, DomainError> {
  if (!ratio.isPositive()) return err(invalidEventRatio(ratio, date));
  // BR-007-04: total cost is passed through untouched. The average is derived
  // from it by `makePosition`, so "adjusts inversely" holds by construction
  // rather than by a second division that could disagree with the first.
  return ok(makePosition(state.quantity.times(ratio), state.totalCost, state.realizedGain));
}

/**
 * SPEC-007 BR-007-05 — **Bonificação:** quantity increases; total cost
 * increases by the value B3 attributes to the bonus shares, or zero where none
 * is attributed; average recomputed.
 *
 * The transaction carries the bonus shares as `quantity` and B3's attributed
 * unit value as `unitPrice` — so the arithmetic is exactly BR-007-02's, and
 * this handler delegates to it rather than restating it.
 *
 * Worked example (DV-17), **with** attributed value — the AC "a bonificação
 * with attributed value increases quantity and total cost, and recomputes
 * average correctly":
 *
 *   Before  100 shares, average 10,00, total cost 1.000,00
 *   Bonificação: 10 shares, B3-attributed value 8,00 each
 *   After   110 shares
 *           total cost = 1.000,00 + 10 × 8,00 = 1.080,00
 *           average    = 1.080,00 ÷ 110       = 9,81818181…
 *
 * Worked example, **without** attributed value (attributed value 0,00) — the
 * AC "a bonificação with zero attributed value increases quantity and reduces
 * average cost proportionally":
 *
 *   Before  100 shares, average 10,00, total cost 1.000,00
 *   Bonificação: 10 shares, nothing attributed
 *   After   110 shares
 *           total cost = 1.000,00            ← unchanged, the shares were free
 *           average    = 1.000,00 ÷ 110      = 9,09090909…
 *
 * The second case is the one people get wrong by leaving the average at 10,00.
 * That overstates cost basis by 10% and understates the eventual realized gain
 * by the same — a number that reconciles against nothing.
 */
export function applyBonus(state: PositionState, input: AcquisitionInput): PositionState {
  return applyAcquisition(state, input);
}

/**
 * SPEC-007 BR-007-06 — **Subscription:** treated as a buy at the subscription
 * price. Exercising a *direito de subscrição* is an acquisition of new shares
 * at a stated price, so nothing distinguishes it arithmetically from a buy;
 * it is named separately so the ledger can still report it as what it was
 * (BR-006-05).
 */
export function applySubscription(state: PositionState, input: AcquisitionInput): PositionState {
  return applyAcquisition(state, input);
}
