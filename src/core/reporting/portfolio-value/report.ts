import type { BusinessDate } from '@/core/shared/clock';
import type { DailyValuationSnapshot } from '@/core/valuation/ports';
import type { Grouping } from '@/core/reporting/ports';
import type { ReportQueryResult } from '@/core/reporting/base-query';
import { decomposeGrowth, headlineFigures } from '@/core/reporting/portfolio-value/decomposition';
import {
  granularityFor,
  monthlyContributions,
  stackedSeries,
  valueSeries,
  withLiveEndpoint,
} from '@/core/reporting/portfolio-value/series';
import type { Freshness, PortfolioValueReport } from '@/core/reporting/portfolio-value/ports';

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
 */

export interface PortfolioValueInput {
  readonly query: ReportQueryResult;
  /**
   * The snapshot immediately **preceding** the range. Growth "during March"
   * is measured from February's close; using March's own first snapshot would
   * discard the first day's movement.
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
  const { snapshots, range, asOf, report } = query;

  const granularity = granularityFor(range.from, range.to);
  const closing = snapshots.at(-1) ?? null;

  const decomposition = decomposeGrowth({ opening, closing });
  const headline = headlineFigures(report.total.value, closing);

  const series = withLiveEndpoint(
    valueSeries(snapshots, granularity),
    asOf,
    report.total.value,
    report.total.estimated,
    today,
  );

  const freshness: Freshness = { valuationAsOf: asOf, lastImportAt };

  return {
    granularity,
    series,
    decomposition,
    headline,
    monthlyContributions: monthlyContributions(snapshots, opening),
    stacked: stackedSeries(snapshots, granularity, grouping),
    freshness,
  };
}
