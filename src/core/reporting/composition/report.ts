import type { ReportQueryResult } from '@/core/reporting/base-query';
import type { DailyValuationSnapshot } from '@/core/valuation/ports';
import { assetRows, sliceBreakdown } from '@/core/reporting/composition/breakdown';
import { flagConcentration } from '@/core/reporting/composition/concentration';
import { allocationDrift } from '@/core/reporting/composition/drift';
import type { CompositionReport } from '@/core/reporting/composition/ports';

/**
 * SPEC-015 — the Composition report, assembled.
 *
 * Everything here is a fold over what `runReportQuery` (SPEC-011) already
 * produced. Nothing re-queries, nothing reaches the ledger, and — the point of
 * DL-015-06 and BR-015-10 — **nothing recomputes the total.**
 *
 * `total` is taken straight off `query.report.total`, which `aggregate` summed
 * from the holdings rather than from its own group subtotals. So the number at
 * the foot of this report's table is *the same object* SPEC-013's headline
 * reports as `currentValue`. Two screens cannot disagree about how much money
 * the user has when only one of them is allowed to add it up. That is the
 * cross-report equality asserted in `totals-invariant.test.ts`, obtained
 * structurally rather than defended by a reconciliation step.
 *
 * **BR-015-11 needs no code here either.** `applyScope` sliced the holding set
 * per wallet before `aggregate` folded it, so at wallet scope every figure
 * below is already the allocated one.
 */
export interface CompositionInput {
  readonly query: ReportQueryResult;
  /**
   * The snapshot immediately preceding the range, for BR-015-04's baseline.
   * Portfolio grain like every other snapshot, and therefore ignored entirely
   * at wallet scope.
   */
  readonly opening: DailyValuationSnapshot | null;
  /** SPEC-002 `reports.concentration_threshold_pct` — the user's number, not ours. */
  readonly thresholdPct: number;
  /** SPEC-008 BR-008-04 — the freshest quote instant behind these figures. */
  readonly quotedAt: Date | null;
  /** SPEC-008 BR-008-04 — the resolved `quotes.cadence_minutes`. */
  readonly delayMinutes: number;
}

export function buildCompositionReport(input: CompositionInput): CompositionReport {
  const { query } = input;

  const breakdown = sliceBreakdown(query.report);

  /**
   * The scoped holding set, recovered from the groups.
   *
   * `aggregate` puts every holding in **exactly one** group, so flattening the
   * groups reproduces the scoped set precisely once — which is why the rows
   * below sum to the same total the slices do, without either being derived
   * from the other.
   */
  const holdings = query.report.groups.flatMap((group) => group.holdings);

  const { rows, concentration } = flagConcentration(
    assetRows(holdings, query.report.total.value),
    input.thresholdPct,
  );

  return {
    grouping: query.report.grouping,
    breakdown,
    rows,
    total: query.report.total,
    drift: allocationDrift({
      opening: input.opening,
      closing: breakdown,
      grouping: query.report.grouping,
      scope: query.scope.scope,
    }),
    concentration,
    quotes: {
      valuationAsOf: query.asOf,
      quotedAt: input.quotedAt,
      delayMinutes: input.delayMinutes,
    },
  };
}
