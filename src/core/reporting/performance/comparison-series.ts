import { Quantity } from '@/core/shared/money';
import type { BusinessDate } from '@/core/shared/clock';
import type {
  Benchmark,
  BenchmarkLine,
  Rate,
  SubPeriodReturn,
} from '@/core/reporting/performance/ports';

/**
 * SPEC-012 BR-012-12 — the portfolio's cumulative return and each benchmark's,
 * on one common basis so they can be drawn on one pair of axes.
 *
 * **Rebased to 100 at the period's first date.** A portfolio's value and an
 * index's level are not the same kind of quantity and must never share an
 * axis; rebasing makes both dimensionless, so vertical distance is the only
 * information on the chart and it means "how far ahead or behind".
 *
 * **The portfolio's line compounds the TWR sub-periods** rather than tracking
 * its value: BR-012-01's whole purpose is that a deposit must not appear as
 * performance, and a value line would show exactly that. `subPeriods` are
 * already the linked daily returns with flows neutralised, so the running
 * product of `(1 + r)` *is* the comparable line.
 *
 * Dates come from the sub-periods rather than from the benchmark, because the
 * portfolio is what the period belongs to; a benchmark with no point on a
 * given date carries its previous factor forward, which is what an index does
 * on a day it did not publish (SPEC-009 BR-009-03's carried-forward close,
 * applied here).
 */

const BASE = Quantity.fromString('100');

export interface ComparisonRow {
  readonly date: BusinessDate;
  /** The portfolio's rebased level. */
  readonly portfolio: Quantity;
  /** One rebased level per benchmark, in the order supplied. */
  readonly benchmarks: ReadonlyMap<Benchmark, Quantity>;
}

export function comparisonSeries(
  subPeriods: readonly SubPeriodReturn[],
  lines: readonly BenchmarkLine[],
): readonly ComparisonRow[] {
  if (subPeriods.length === 0) return [];

  /**
   * One entry per benchmark, holding both its published points and its running
   * factor. Two parallel maps would need a `?? default` on each lookup, and
   * those defaults are unreachable — both maps are built from the same
   * `lines`, so a miss is impossible. An unreachable branch is not a safety
   * net; it is a line no test can justify and a reader has to reason about.
   */
  const tracked = lines.map((line) => ({
    benchmark: line.benchmark,
    published: new Map<string, Rate>(line.points.map((point) => [point.date, point.factor])),
    // Carried forward across dates the index did not publish. Starts at 1 so a
    // benchmark whose series begins after the period does rebase to 100
    // rather than vanishing.
    factor: Quantity.fromString('1'),
  }));

  let portfolioFactor = Quantity.fromString('1');
  const rows: ComparisonRow[] = [];

  for (const subPeriod of subPeriods) {
    portfolioFactor = portfolioFactor.times(Quantity.fromString('1').plus(subPeriod.rate));

    const benchmarks = new Map<Benchmark, Quantity>();
    for (const entry of tracked) {
      entry.factor = entry.published.get(subPeriod.range.to) ?? entry.factor;
      benchmarks.set(entry.benchmark, entry.factor.times(BASE));
    }

    rows.push({
      date: subPeriod.range.to,
      portfolio: portfolioFactor.times(BASE),
      benchmarks,
    });
  }

  return rows;
}
