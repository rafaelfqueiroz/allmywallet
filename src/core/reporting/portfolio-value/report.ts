import type { BusinessDate } from '@/core/shared/clock';
import type { DailyValuationSnapshot } from '@/core/valuation/ports';
import type { Grouping } from '@/core/reporting/ports';
import type { ReportQueryResult } from '@/core/reporting/base-query';
import { decomposeGrowth, investedFigures } from '@/core/reporting/portfolio-value/decomposition';
import {
  granularityFor,
  monthlyContributions,
  stackedSeries,
  valueSeries,
  withLiveEndpoint,
} from '@/core/reporting/portfolio-value/series';
import {
  HistoryUnavailable,
  available,
  unavailable,
  type Freshness,
  type PortfolioValueReport,
} from '@/core/reporting/portfolio-value/ports';

/**
 * SPEC-013 — the Portfolio Value report, assembled.
 *
 * Everything here is a fold over what `runReportQuery` (SPEC-011) already
 * produced: the snapshot range for the line, and the grouped holdings for the
 * headline. Nothing re-queries and nothing reaches the ledger, which is what
 * keeps BR-013-11 and TS-32 true rather than aspirational.
 *
 * **The headline value and the chart's endpoint are the same figure**, taken
 * from the valued holdings rather than from the last snapshot. That is
 * BR-013-12: the Composition report totals those same holdings, so the two
 * screens cannot disagree about how much money the user has. Where the last
 * snapshot differs from the live valuation, the difference is snapshot
 * staleness — a fact about the pipeline, not a second opinion about the
 * portfolio.
 *
 * ## The two grains this file has to keep apart
 *
 * `runReportQuery` hands back two things that look equally scoped and are not.
 *
 *  - `report` is the **scoped** holding set. `applyScope` (SPEC-011
 *    `scope.ts`) has already sliced it per wallet, so `report.total.value` is
 *    this wallet's money and nothing else's.
 *  - `snapshots` is the **portfolio's** daily series.
 *    `daily_valuation_snapshots` holds one row per user per day and carries no
 *    wallet column at all (SPEC-009 BR-009-16, ADR-002), so `listSnapshots`
 *    returns the same rows whatever the scope asked for.
 *
 * Combining the two produced a number that was arithmetically perfect and
 * entirely false. A user with a R$ 400.000 portfolio who files R$ 10.000 into
 * "Reserva" and opens that wallet saw, by hand:
 *
 *   totalInvested = snapshot.netContributions   = 400.000   ← the portfolio's
 *   absoluteGain  = 10.000 − 400.000            = −390.000
 *   gainRatio     = −390.000 ÷ 400.000          = −0,975    → **−97,5 %**
 *
 * and a chart that ran flat at R$ 400.000 for the whole period before
 * cliff-dropping to R$ 10.000 on the live endpoint, because `withLiveEndpoint`
 * splices the *scoped* value onto the end of the *portfolio's* line.
 */

export interface PortfolioValueInput {
  readonly query: ReportQueryResult;
  /**
   * The snapshot immediately **preceding** the range. Growth "during March"
   * is measured from February's close; using March's own first snapshot would
   * discard the first day's movement.
   *
   * Portfolio grain, like every other snapshot, and therefore ignored entirely
   * at wallet scope.
   */
  readonly opening: DailyValuationSnapshot | null;
  readonly grouping: Grouping;
  readonly today: BusinessDate;
  /** SPEC-005 BR-005-27 — `null` before the first custody import. */
  readonly lastImportAt: BusinessDate | null;
}

export function buildPortfolioValueReport({
  query,
  opening,
  grouping,
  today,
  lastImportAt,
}: PortfolioValueInput): PortfolioValueReport {
  const { snapshots, range, asOf, report, scope } = query;

  const granularity = granularityFor(range.from, range.to);
  const freshness: Freshness = { valuationAsOf: asOf, lastImportAt };

  /**
   * SPEC-011 BR-011-02 / SPEC-013 BR-013-11 — **at wallet scope every
   * snapshot-derived figure is reported as unavailable, not approximated from
   * the portfolio's.**
   *
   * This is the refusal SPEC-012 already makes for TWR and XIRR
   * (`performance/report.ts`, `SCOPE_SERIES_UNAVAILABLE`), applied to the same
   * cause. The substitution is dangerous precisely because it is undetectable:
   * R$ 400.000 of contributions is a true fact about this user, so nothing on
   * the screen looks broken, and the only way to find out is to reconcile
   * against a broker statement — at which point every figure the product has
   * ever shown is in question.
   *
   * **The wallet's own figures survive**, which is what keeps this a useful
   * screen rather than an error page: `headline.currentValue` is the scoped
   * holding total (BR-013-12, the same number Composition shows), and the
   * grouped holdings on `query.report` are untouched. What disappears is
   * exactly what history cannot answer.
   *
   * ADR-002 (`docs/adr/002-historical-breakdown-storage.md`) records why the
   * fix is not "give snapshots a wallet dimension": `wallet_allocations` stores
   * only its current state, so writing today's split into past rows would
   * rewrite every historical chart on the next reassignment and a rebuild would
   * disagree with the snapshot it replaced (DM-4). Effective-dated allocation
   * history is backlog issue #50.
   */
  if (scope.scope.kind === 'wallet') {
    const reason = HistoryUnavailable.WALLET_SCOPE_NOT_SNAPSHOTTED;
    return {
      granularity,
      series: unavailable(reason),
      decomposition: unavailable(reason),
      headline: { currentValue: report.total.value, invested: unavailable(reason) },
      monthlyContributions: unavailable(reason),
      stacked: { kind: 'unavailable', grouping, reason },
      freshness,
    };
  }

  const closing = snapshots.at(-1) ?? null;

  return {
    granularity,
    series: available(
      withLiveEndpoint(
        valueSeries(snapshots, granularity),
        asOf,
        report.total.value,
        report.total.estimated,
        today,
      ),
    ),
    decomposition: available(decomposeGrowth({ opening, closing })),
    headline: {
      currentValue: report.total.value,
      invested: available(investedFigures(report.total.value, closing)),
    },
    monthlyContributions: available(monthlyContributions(snapshots, opening)),
    stacked: stackedSeries(snapshots, granularity, grouping),
    freshness,
  };
}
