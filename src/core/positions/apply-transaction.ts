import type { DomainError } from '@/core/shared/domain-error';
import { type Result, err, ok } from '@/core/shared/result';
import type { Transaction } from '@/core/ledger/transaction';
import type { PositionState } from '@/core/positions/position-state';
import { applyAcquisition, applySale, applyWithdrawal } from '@/core/positions/average-cost';
import {
  applyBonus,
  applyShareRatioEvent,
  applySubscription,
} from '@/core/positions/corporate-events';
import { missingEventRatio } from '@/core/positions/errors';

/**
 * The one place a transaction type is turned into an effect on a position.
 *
 * Exhaustive by construction: every one of BR-006-05's thirteen types has a
 * case, and the switch has **no `default`**, so adding a fourteenth type stops
 * the build rather than silently falling through to "no effect". A default
 * branch here would be the cheapest possible way to lose a corporate event.
 */
export function applyTransaction(
  state: PositionState,
  transaction: Transaction,
): Result<PositionState, DomainError> {
  const { quantity, unitPrice, fees, tradeDate } = transaction;

  switch (transaction.type) {
    // SPEC-007 BR-007-02: fees increase cost basis.
    case 'buy':
      return ok(applyAcquisition(state, { quantity, unitPrice, fees }));

    // SPEC-007 BR-007-06: a subscription is a buy at the subscription price.
    case 'subscription':
      return ok(applySubscription(state, { quantity, unitPrice, fees }));

    /**
     * Shares arriving from another custodian. BR-007-08 tracks positions per
     * `(user, asset, institution)`, so a transfer is two rows — a
     * `transfer_out` at the source and a `transfer_in` at the destination —
     * and the destination lot is opened at the cost the source recorded,
     * carried on `unitPrice`. Treating it as a zero-cost arrival would show a
     * *preço médio* of nothing and an eventual realized gain equal to the
     * entire proceeds.
     */
    case 'transfer_in':
      return ok(applyAcquisition(state, { quantity, unitPrice, fees }));

    // SPEC-007 BR-007-05: quantity up, total cost up by B3's attributed value
    // (or zero), average recomputed.
    case 'bonificacao':
      return ok(applyBonus(state, { quantity, unitPrice, fees }));

    // SPEC-007 BR-007-04. Both types share the arithmetic; only the ratio
    // differs (>1 splits, <1 groups).
    case 'split':
    case 'grupamento':
      if (transaction.ratio === null) return err(missingEventRatio(tradeDate));
      return applyShareRatioEvent(state, transaction.ratio, tradeDate);

    // SPEC-007 BR-007-03/09: quantity down, average unchanged, gain realised.
    case 'sell':
      return applySale(state, { quantity, unitPrice, fees, date: tradeDate });

    /**
     * Shares leaving for another custodian. Not a disposal: no gain is
     * realised (see `applyWithdrawal`). Any `fees` on the row are a cash
     * expense, not part of the cost basis of shares that are still held —
     * they are deliberately not capitalised into the remaining lot, which
     * would otherwise raise the *preço médio* of shares the user never traded.
     */
    case 'transfer_out':
      return applyWithdrawal(state, quantity, tradeDate);

    case 'adjustment':
      return applyAdjustment(state, transaction);

    /**
     * SPEC-014's proventos. Recognised at pay date as earnings, never as a
     * change in quantity and never assumed reinvested — so the position is
     * returned untouched. `amortization` sits here too: it returns principal
     * in cash, which SPEC-014 reports and SPEC-009 values; it is not a share
     * count and does not move cost basis in v1.
     */
    case 'dividend':
    case 'jcp':
    case 'rendimento':
    case 'amortization':
      return ok(state);
  }
}

/**
 * A reconciliation correction (SPEC-005 inserts these where a B3 *Posição*
 * extract disagrees with the replayed ledger). The **sign of the quantity**
 * carries the direction, and the two directions are deliberately asymmetric:
 *
 *   - **positive** — shares appear that the ledger did not know about. They
 *     arrive at the stated `unitPrice`, exactly like a buy, because a
 *     correction still has to say what the shares cost. Worked example: a
 *     position of 100 @ 10,00 (total 1.000,00) plus an adjustment of +10 at
 *     9,00 gives 110 shares, total 1.090,00, average 9,90909090…
 *
 *   - **negative** — shares the ledger thinks are held are not. They leave at
 *     **average cost**, so the average is unchanged and **no gain is
 *     realised**. A bookkeeping correction is not a sale; realising a gain on
 *     one would put money in the user's tax figures that no broker ever
 *     reported. Worked example: the same 100 @ 10,00 less an adjustment of
 *     −10 gives 90 shares, total 900,00, average 10,00 — untouched.
 */
function applyAdjustment(
  state: PositionState,
  transaction: Transaction,
): Result<PositionState, DomainError> {
  const { quantity, unitPrice, fees, tradeDate } = transaction;
  if (quantity.isNegative()) {
    return applyWithdrawal(state, quantity.negated(), tradeDate);
  }
  return ok(applyAcquisition(state, { quantity, unitPrice, fees }));
}
