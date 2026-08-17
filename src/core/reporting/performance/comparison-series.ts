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

  const byBenchmark = new Map<Benchmark, Map<string, Rate>>(
    lines.map((line) => [line.benchmark, new Map(line.points.map((p) => [p.date, p.factor]))]),
  );
  // Carried forward across dates the index did not publish.
  const lastFactor = new Map<Benchmark, Quantity>(
    lines.map((line) => [line.benchmark, Quantity.fromString('1')]),
  );

  let portfolioFactor = Quantity.fromString('1');
  const rows: ComparisonRow[] = [];

  for (const subPeriod of subPeriods) {
    portfolioFactor = portfolioFactor.times(Quantity.fromString('1').plus(subPeriod.rate));

    const benchmarks = new Map<Benchmark, Quantity>();
    for (const line of lines) {
      const published = byBenchmark.get(line.benchmark)?.get(subPeriod.range.to);
      const factor = published ?? lastFactor.get(line.benchmark) ?? Quantity.fromString('1');
      lastFactor.set(line.benchmark, factor);
      benchmarks.set(line.benchmark, factor.times(BASE));
    }

    rows.push({
      date: subPeriod.range.to,
      portfolio: portfolioFactor.times(BASE),
      benchmarks,
    });
  }

  return rows;
}
