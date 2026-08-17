import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Quantity } from '@/core/shared/money';
import { comparisonSeries } from '@/core/reporting/performance/comparison-series';
import type { BenchmarkLine, SubPeriodReturn } from '@/core/reporting/performance/ports';

const day = (d: string) => BusinessDate.of(d);

function sub(from: string, to: string, rate: string): SubPeriodReturn {
  return {
    range: { from: day(from), to: day(to) },
    rate: Quantity.fromString(rate),
    dietz: false,
  };
}

function line(points: readonly [string, string][]): BenchmarkLine {
  return {
    benchmark: 'CDI',
    points: points.map(([date, factor]) => ({
      date: day(date),
      factor: Quantity.fromString(factor),
    })),
    returnRate: Quantity.fromString('0'),
  };
}

describe('SPEC-012 BR-012-12 — the comparison series', () => {
  it('rebases the portfolio to 100 and compounds the sub-period returns', () => {
    // 10 % then 10 % compounds to 21 %, not 20 %. Hand-computed: 1.1 × 1.1 = 1.21.
    const rows = comparisonSeries(
      [sub('2026-01-01', '2026-01-02', '0.1'), sub('2026-01-02', '2026-01-03', '0.1')],
      [],
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.portfolio.toString()).toBe('110');
    expect(rows[1]?.portfolio.toString()).toBe('121');
  });

  it('a loss pulls the level below 100', () => {
    const rows = comparisonSeries([sub('2026-01-01', '2026-01-02', '-0.25')], []);
    expect(rows[0]?.portfolio.toString()).toBe('75');
  });

  it('puts the benchmark on the same rebased basis, so the two are comparable', () => {
    const rows = comparisonSeries(
      [sub('2026-01-01', '2026-01-02', '0.1')],
      [line([['2026-01-02', '1.05']])],
    );

    expect(rows[0]?.portfolio.toString()).toBe('110');
    expect(rows[0]?.benchmarks.get('CDI')?.toString()).toBe('105');
  });

  it('carries a benchmark forward on a date it did not publish, rather than dropping to zero', () => {
    // The index published on the 2nd and not on the 3rd. Its line must stay
    // flat, not fall off the chart — a gap would read as a crash.
    const rows = comparisonSeries(
      [sub('2026-01-01', '2026-01-02', '0'), sub('2026-01-02', '2026-01-03', '0')],
      [line([['2026-01-02', '1.05']])],
    );

    expect(rows[0]?.benchmarks.get('CDI')?.toString()).toBe('105');
    expect(rows[1]?.benchmarks.get('CDI')?.toString()).toBe('105');
  });

  it('starts a benchmark at 100 when its first point comes later than the period', () => {
    const rows = comparisonSeries([sub('2026-01-01', '2026-01-02', '0')], [line([])]);
    expect(rows[0]?.benchmarks.get('CDI')?.toString()).toBe('100');
  });

  it('an empty period produces no rows rather than a single flat point', () => {
    expect(comparisonSeries([], [line([['2026-01-02', '1.05']])])).toEqual([]);
  });
});
