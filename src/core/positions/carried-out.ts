import type { DomainError } from '@/core/shared/domain-error';
import type { TransactionId } from '@/core/shared/ids';
import { asStored, Money } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import type { Transaction } from '@/core/ledger/transaction';
import { applyTransaction } from '@/core/positions/apply-transaction';
import { sortForReplay } from '@/core/positions/ordering';
import { EMPTY_POSITION } from '@/core/positions/position-state';
import { positionKeyString, type ReplayOptions, selectForReplay } from '@/core/positions/replay';

/**
 * SPEC-013 BR-013-08 (amended 2026-09-29) / DL-013-08 — **the cost a
 * `transfer_out` carries away** from its source position.
 *
 * A transfer is a flow at the cost basis it carries: a `transfer_in` at the
 * cost it opens with, a `transfer_out` at the cost it takes away. B3 exports
 * the debit leg with no price (SPEC-005 BR-005-20a), so the debit's stated
 * price says nothing — its cost is a fact about the **source position at that
 * point of the replay**, and only a fold can read it. That is what this is:
 * the same fold as `replayPosition`, in the same order (`compareForReplay`,
 * BR-007-15), noting the source's *preço médio* at each `transfer_out`.
 *
 * ## The figure, and its one rounding step
 *
 *   carried out = quantity × round₈(source *preço médio* before the debit)
 *
 * where round₈ is `asStored`: `NUMERIC(20,8)`, `ROUND_HALF_UP`.
 *
 * It is rounded because the credit it pairs with is. SPEC-005's
 * `withCarriedCost` stores the carried *preço médio* on the credit's
 * `unit_price`, a `NUMERIC(20,8)` column, so a credit flows in at
 * `quantity × round₈(avg)`. Were the debit to flow out at the unrounded
 * `quantity × avg` — the literal figure `applyWithdrawal` takes off total
 * cost — every pair whose average repeats would leave a residual of
 * `quantity × (round₈(avg) − avg)`, up to `quantity × 0,000000005`, and that
 * residual survives into the stored `net_contributions`.
 *
 * Worked example (DV-17), a real-shaped repeating average:
 *
 *   Clear holds 7 shares bought @ 18,99 + 0,03 fees  → total cost 132,96
 *     preço médio  = 132,96 ÷ 7          = 18,994285714285714…
 *     round₈       =                       18,99428571
 *   credit at XP carries 18,99428571      → flows in  + 7 × 18,99428571 = +132,95999997
 *   debit at Clear, unrounded             → flows out − 132,96
 *     residual     = −0,00000003          ← visible at NUMERIC(20,8)
 *   debit at Clear, round₈ (this)         → flows out − 7 × 18,99428571 = −132,95999997
 *     net          =  0,00000000          ← exactly zero, as BR-013-08 requires
 *
 * The rounded figure differs from the cost the position actually drops by
 * less than `quantity × 0,000000005` — on 455 shares, under R$ 0,0000023 —
 * which moves no figure a user can see; the residual it removes would put a
 * permanent non-zero *Ganho* on every repeating-average transfer and fail
 * the one property DL-013-08 exists to make exact. Where the average
 * terminates within eight places (1.461,82 ÷ 128 = 11,42046875;
 * 17.710,61 ÷ 800 = 22,1382625) round₈ is the identity and the two readings
 * agree to the last digit.
 *
 * **A same-institution round trip nets to zero as well** (#135). There the
 * credit (rank 0) applies *before* the debit (rank 6), so the debit sees the
 * average A′ of the position with the credit already in it. A′ is a weighted
 * mean of A and round₈(A), so it lies between them and rounds to the same
 * round₈(A) — the figure the credit carried.
 *
 * ## What cannot be valued is not valued as zero
 *
 * A transfer out of a position whose replay fails at or before it — the debit
 * removes more than was held, or an earlier row cannot be applied — has no
 * cost to carry, and returns that failure. Flowing R$ 0 there is the exact
 * defect #181 fixed. Rows sorting *after* a position's last `transfer_out`
 * are not folded: nothing here depends on them, and their own failures are
 * the valuation's to report (`valuePortfolioAt`).
 *
 * Keyed by transaction id. Only `active` rows on or before `options.asOf`
 * participate (`selectForReplay`), exactly as in every other fold.
 */
export function costsCarriedOut(
  transactions: readonly Transaction[],
  options: ReplayOptions = {},
): Result<ReadonlyMap<TransactionId, Money>, DomainError> {
  // BR-007-08: a cost is a fact about one (asset, institution) position.
  const positions = new Map<string, Transaction[]>();
  for (const transaction of selectForReplay(transactions, options)) {
    const key = positionKeyString(transaction);
    const rows = positions.get(key);
    if (rows === undefined) positions.set(key, [transaction]);
    else rows.push(transaction);
  }

  const carried = new Map<TransactionId, Money>();
  for (const rows of positions.values()) {
    const ordered = sortForReplay(rows);
    // Fold only as far as the last debit: everything the costs depend on sorts
    // before it. `-1` (no debit) folds nothing.
    let lastDebit = -1;
    ordered.forEach((row, index) => {
      if (row.type === 'transfer_out') lastDebit = index;
    });
    let state = EMPTY_POSITION;
    for (const row of ordered.slice(0, lastDebit + 1)) {
      const next = applyTransaction(state, row, options.amortization);
      if (!next.ok) return err(next.error);
      if (row.type === 'transfer_out') {
        // SPEC-013 BR-013-08: the source's preço médio immediately before the
        // debit, at the scale the paired credit stores it — see above.
        carried.set(row.id, Money.fromString(asStored(state.averageCost)).times(row.quantity));
      }
      state = next.value;
    }
  }
  return ok(carried);
}
