import { Money } from '@/core/shared/money';
import type { DailyValuationSnapshot } from '@/core/valuation/ports';
import type { GrowthDecomposition, HeadlineFigures } from '@/core/reporting/portfolio-value/ports';

/**
 * SPEC-013 BR-013-02/03 — growth split into net contributions, price change
 * and earnings.
 *
 * **The two cumulative columns are what make this cheap.** A snapshot's
 * `net_contributions` and `earnings_to_date` are running totals to that date,
 * so the amount attributable to a *period* is the difference between its ends.
 * No ledger is read, which is what keeps the report inside DL-011-07's budget.
 *
 * **Price change is the residual, deliberately.** BR-013-03 requires
 * `closing − opening = contributions + priceChange + earnings`, and defining
 * `priceChange` as `(closing − opening) − contributions − earnings` makes that
 * an identity rather than a coincidence. Two reasons that is the honest
 * arrangement and not a way of dodging the check:
 *
 * 1. **The alternative is not more truthful, only more expensive.** Computing
 *    price change independently means valuing every position at both ends of
 *    the range and differencing per asset — which is the ledger replay this
 *    report is forbidden from doing, and which would still disagree with the
 *    snapshot line the chart draws.
 * 2. **It relocates the risk to where the tests can reach it.** With the
 *    identity guaranteed, a miscounted transaction type cannot break the
 *    reconciliation — it shows up as a *wrong price change*, silently. So the
 *    tests that matter are the ones that pin contributions and earnings
 *    against hand-computed figures (TS-04), not the ones that re-add the three
 *    numbers. `decomposition.test.ts` is written accordingly: the reconciliation
 *    assertion is there to catch a refactor, and the driver assertions are
 *    there to catch a defect.
 *
 * The opening snapshot is the one **before** the range, not the first inside
 * it. Growth "during March" means the change from the closing figure of
 * February — using March's first snapshot as the opening silently discards
 * the first day's movement, which is the classic off-by-one in every
 * period-return implementation.
 */

export interface DecompositionInput {
  /**
   * The snapshot immediately preceding the range, or `null` when the range
   * starts at or before the first snapshot the tenant has. `null` means the
   * portfolio opened at zero — which is correct for a first period, and is why
   * a brand-new account's entire value shows as contributions rather than as
   * unexplained price change.
   */
  readonly opening: DailyValuationSnapshot | null;
  /** The last snapshot within the range. `null` when the range holds none. */
  readonly closing: DailyValuationSnapshot | null;
}

const ZERO_DECOMPOSITION: GrowthDecomposition = {
  opening: Money.zero(),
  closing: Money.zero(),
  netContributions: Money.zero(),
  priceChange: Money.zero(),
  earnings: Money.zero(),
};

export function decomposeGrowth({ opening, closing }: DecompositionInput): GrowthDecomposition {
  // No snapshot inside the range: there is nothing to decompose, and a report
  // of zeros is the correct answer rather than a failure. `empty` on the
  // enclosing query is what drives the explanatory empty state (BR-011-16).
  if (closing === null) return ZERO_DECOMPOSITION;

  const openingValue = opening?.totalValue ?? Money.zero();
  const openingContributions = opening?.netContributions ?? Money.zero();
  const openingEarnings = opening?.earningsToDate ?? Money.zero();

  const netContributions = closing.netContributions.minus(openingContributions);
  const earnings = closing.earningsToDate.minus(openingEarnings);
  const growth = closing.totalValue.minus(openingValue);

  return {
    opening: openingValue,
    closing: closing.totalValue,
    netContributions,
    // AR-09: no rounding here. Every figure is an intermediate for some
    // display, and quantising a residual is how a reconciliation that holds
    // in the domain starts failing on screen by a centavo.
    priceChange: growth.minus(netContributions).minus(earnings),
    earnings,
  };
}

/**
 * BR-013-04 — current value, total invested, and gain in both forms.
 *
 * `currentValue` is passed in rather than taken from the closing snapshot, and
 * that is BR-013-12/DL-013-06 doing its work: the Composition report totals
 * the *valued holdings*, so this report must headline the same number or the
 * two screens disagree about how much money the user has. Reading the snapshot
 * instead would be a second, independently-derived answer to the one question
 * a user checks across both.
 *
 * `totalInvested` does come from the snapshot, because "what did I put in" is
 * a cumulative ledger fact rather than a valuation, and the snapshot is where
 * that running total lives (BR-013-08).
 */
export function headlineFigures(
  currentValue: Money,
  closing: DailyValuationSnapshot | null,
): HeadlineFigures {
  const totalInvested = closing?.netContributions ?? Money.zero();
  const absoluteGain = currentValue.minus(totalInvested);

  return {
    currentValue,
    totalInvested,
    absoluteGain,
    // A ratio against zero (or against a negative, which happens once a user
    // has withdrawn more than they ever put in) is undefined, not infinite.
    gainRatio: totalInvested.isPositive()
      ? absoluteGain.dividedBy(totalInvested.toDecimal())
      : null,
  };
}
