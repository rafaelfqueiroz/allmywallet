import type { Transaction } from '@/core/ledger/transaction';
import type { PositionState } from '@/core/positions/position-state';

/**
 * SPEC-007 BR-007-06 (amended 2026-09-21) / DL-007-12 — whether a position's
 * cost is an estimate.
 *
 * *Preço médio* is an average, so one estimated lot makes the whole figure an
 * estimate until the position closes (DL-007-12). The marker is therefore a
 * property of the **open lot**, decided by the same fold that computes the
 * average — which is what makes a rebuild and the incrementally-maintained
 * cache agree on it (DL-007-06 / DM-4): both are that fold.
 *
 * It is deliberately *not* a field of `PositionState`. That state is the
 * arithmetic — four figures `positionsEqual` compares and every handler in
 * `average-cost.ts` / `corporate-events.ts` returns — and none of those
 * handlers has anything to decide about the marker. Folding it alongside the
 * state keeps the one rule in one place instead of threading it through every
 * handler, where one forgotten copy would drop it silently.
 */

/**
 * The transaction types whose own figures put cost *into* the open lot, and
 * so the ones whose `costIsEstimate` makes the lot's cost an estimate:
 *
 *   - `buy`, `subscription` (BR-007-06: a buy at the subscription price),
 *     `transfer_in` (opens the lot at the carried source cost) and positive
 *     `adjustment` — cost is `unitPrice × quantity + fees` (BR-007-02);
 *   - `conversion_in` — cost is the allocated `costBasis` (BR-007-05b);
 *   - `bonificacao` — total cost rises by the value B3 attributes (BR-007-05).
 *     A bonificação marked estimated has an attributed value that is itself
 *     an estimate, zero included: an estimated zero is still an estimate, and
 *     the failure DL-007-12 names is an estimate that looks exact.
 *
 * Everything else cannot mark a position. A sale, transfer out, conversion out
 * or negative adjustment removes shares **at the average** (BR-007-03,
 * BR-007-05b), so the average it leaves is still the estimated one — they
 * neither set nor clear the marker. A split or grupamento moves quantity at
 * unchanged total cost (BR-007-04) and a bonificação fraction leaves at
 * unchanged total cost (BR-007-05a). An amortization only takes cost *out*
 * (BR-007-05c), so what remains of an estimated cost is still an estimate.
 * Other proventos never touch the position.
 */
function addsCost(transaction: Transaction): boolean {
  switch (transaction.type) {
    case 'buy':
    case 'subscription':
    case 'transfer_in':
    case 'conversion_in':
    case 'bonificacao':
      return true;
    case 'adjustment':
      // The sign carries the direction (`apply-transaction.ts`): only a
      // positive correction arrives at a stated price.
      return transaction.quantity.isPositive();
    case 'sell':
    case 'transfer_out':
    case 'conversion_out':
    case 'split':
    case 'grupamento':
    case 'fracao_bonificacao':
    case 'dividend':
    case 'jcp':
    case 'rendimento':
    case 'amortization':
    case 'leilao_fracoes':
      return false;
  }
}

/**
 * The marker after `transaction` has been applied, given the marker before it
 * and the state it produced.
 *
 * SPEC-007 BR-007-07: a position that reaches zero starts a new lot, so the
 * marker resets exactly where `makePosition` resets the average. Checked
 * first, so no route to zero — a sale, a transfer out, a conversion out, a
 * negative adjustment — can leave a stale marker on a later, exact lot.
 *
 * Worked example (DV-17):
 *
 *   buy 100 @ 10,00                         → exact     (100, 1.000,00)
 *   subscription 20 @ 114,90, estimated     → estimated (120, 3.298,00, 27,4833…)
 *   sell 60                                 → estimated (60 @ 27,4833… — the
 *                                             same estimated average)
 *   sell 60                                 → exact, 0  (closed: BR-007-07)
 *   buy 10 @ 12,00                          → exact     (a new lot)
 */
export function costEstimatedAfter(
  before: boolean,
  after: PositionState,
  transaction: Transaction,
): boolean {
  if (after.quantity.isZero()) return false;
  return before || (transaction.costIsEstimate && addsCost(transaction));
}
