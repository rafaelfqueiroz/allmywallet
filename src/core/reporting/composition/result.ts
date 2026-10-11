import type { Money } from '@/core/shared/money';
import type { ReportTotals } from '@/core/reporting/ports';

/**
 * SPEC-015 BR-015-08, at the grain of a total — `value − costBasis` for a
 * scope, a group or a wallet, and that figure against the cost.
 *
 * BR-015-08 states the unrealised gain per asset row; SPEC-022's Portfólio
 * (BR-022-02, BR-022-34) shows the same figure for the whole scope, each asset
 * class and each wallet. It is the **same subtraction over figures the report
 * already holds**: both operands are `ReportTotals` folded by
 * `runReportQuery` from one holding set (BR-011-08), so a group's result and
 * the scope's result cannot disagree about the money underneath them. Nothing
 * here reads a price or a cost of its own.
 *
 * `ratio` is a **fraction** (`0,25`, not `25`), like every share in this
 * module — the ×100 belongs to `formatPercent`. It is `null` unless the cost is
 * positive: a result on nothing is undefined rather than infinite, and a cost
 * at or below zero (a position whose cost has been fully returned by
 * amortizations) would turn a gain into a negative ratio, which reads as a
 * loss. `investedFigures` (SPEC-013) makes the same refusal for the same
 * reason.
 */
export interface UnrealizedResult {
  readonly result: Money;
  readonly ratio: Money | null;
}

export function unrealizedResult(
  totals: Pick<ReportTotals, 'value' | 'costBasis'>,
): UnrealizedResult {
  const result = totals.value.minus(totals.costBasis);
  return {
    result,
    ratio: totals.costBasis.isPositive() ? result.dividedBy(totals.costBasis.toDecimal()) : null,
  };
}
