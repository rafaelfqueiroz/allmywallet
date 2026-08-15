import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import {
  accumulateLevelSeries,
  accumulateRateSeries,
  interpolateMonthlyToDaily,
  percentOfCdi,
  realReturn,
  shadowPortfolio,
} from '@/core/reporting/performance/benchmark';
import {
  Rate,
  type BenchmarkLine,
  type DatedFlow,
  type IndexSeriesPoint,
} from '@/core/reporting/performance/ports';

/**
 * SPEC-012 BR-012-10..14 — benchmarks.
 *
 * TS-04/TS-05: every figure below is hand-computed. The CDI accumulations are
 * deliberately short and use rates whose product terminates, so the expectation
 * is an exact decimal rather than a tolerance.
 */

const day = (value: string): BusinessDate => BusinessDate.of(value);
const money = (value: string): Money => Money.fromString(value);

function points(entries: readonly [string, string][]): readonly IndexSeriesPoint[] {
  return entries.map(([date, value]) => ({ date: day(date), value: Quantity.fromString(value) }));
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`expected a value, got ${result.error.code}`);
  return result.value;
}

function errorCode(result: { ok: true } | { ok: false; error: { code: string } }): string {
  if (result.ok) throw new Error('expected an unavailable result');
  return result.error.code;
}

describe('SPEC-012 BR-012-13 — the CDI line (a rate series)', () => {
  /**
   * Hand-computed, two published days at 0,04 % and 0,06 % per day:
   *
   *   factor = 1,0004 × 1,0006
   *          = 1 + 0,0004 + 0,0006 + 0,00000024
   *          = **1,00100024**   → a period return of 0,100024 %
   *
   * The line's own points are the accumulation **at the start of each day**, so
   * the first is exactly 1 and the last carries the whole period.
   */
  it('compounds published daily rates over the half-open window', () => {
    const line = unwrap(
      accumulateRateSeries(
        'CDI',
        points([
          ['2026-03-02', '0.04'],
          ['2026-03-03', '0.06'],
        ]),
        day('2026-03-02'),
        day('2026-03-04'),
      ),
    );

    expect(line.points.map((point) => point.factor.toString())).toEqual([
      '1',
      '1.0004',
      '1.00100024',
    ]);
    expect(line.returnRate.toString()).toBe('0.00100024');
    expect(line.benchmark).toBe('CDI');
  });

  it('does not compound a business day BCB has not published yet', () => {
    // BR-009-08's treatment, carried over: a missing point is publication lag,
    // not a zero rate and not a guess. Only the 2nd compounds here.
    const line = unwrap(
      accumulateRateSeries(
        'CDI',
        points([['2026-03-02', '0.05']]),
        day('2026-03-02'),
        day('2026-03-04'),
      ),
    );
    // 1,0005 and nothing more.
    expect(line.returnRate.toString()).toBe('0.0005');
  });

  it('refuses a reversed range rather than returning a flat line', () => {
    const result = accumulateRateSeries('CDI', [], day('2026-03-04'), day('2026-03-02'));
    expect(errorCode(result)).toBe('PERFORMANCE_BENCHMARK_SERIES_EMPTY');
  });

  it('refuses a window with no published point in it at all', () => {
    // A missing *day* is publication lag and does not compound. A window with
    // nothing in it is missing *data*, and the empty product would draw a flat
    // line that reads as "CDI did nothing" — and then divide "% do CDI" by zero.
    const result = accumulateRateSeries(
      'CDI',
      points([['2025-01-02', '0.05']]),
      day('2026-03-02'),
      day('2026-03-04'),
    );
    expect(errorCode(result)).toBe('PERFORMANCE_BENCHMARK_SERIES_EMPTY');
  });
});

describe('SPEC-012 BR-012-13 — the IBOV line (a level series)', () => {
  /**
   * Hand-computed: the index closed at 100.000 before the period and 110.000 on
   * the 5th, with no trading in between.
   *
   *   factor(5 Jan) = 110.000 ÷ 100.000 = 1,10  → **+10 %**
   *
   * The days between carry the last observed level forward rather than dropping
   * out of the chart.
   */
  it('divides by the baseline level and carries closed days forward', () => {
    const line = unwrap(
      accumulateLevelSeries(
        'IBOV',
        points([
          ['2025-12-31', '100000'],
          ['2026-01-05', '110000'],
        ]),
        day('2026-01-01'),
        day('2026-01-05'),
      ),
    );

    expect(line.points.map((point) => point.factor.toString())).toEqual([
      '1',
      '1',
      '1',
      '1',
      '1.1',
    ]);
    expect(line.returnRate.toString()).toBe('0.1');
  });

  it('refuses when there is no level to divide by', () => {
    const result = accumulateLevelSeries('IBOV', [], day('2026-01-01'), day('2026-01-05'));
    expect(errorCode(result)).toBe('PERFORMANCE_BENCHMARK_SERIES_EMPTY');
  });

  it('refuses a baseline level of zero rather than dividing by it', () => {
    const result = accumulateLevelSeries(
      'IBOV',
      points([['2026-01-01', '0']]),
      day('2026-01-01'),
      day('2026-01-05'),
    );
    expect(errorCode(result)).toBe('PERFORMANCE_BENCHMARK_SERIES_EMPTY');
  });

  it('refuses a reversed range', () => {
    const result = accumulateLevelSeries(
      'IBOV',
      points([['2026-01-01', '100000']]),
      day('2026-01-05'),
      day('2026-01-01'),
    );
    expect(errorCode(result)).toBe('PERFORMANCE_BENCHMARK_SERIES_EMPTY');
  });
});

describe('SPEC-012 BR-012-13 — IPCA, monthly, interpolated to daily', () => {
  /**
   * The interpolation must be **neutral**: it decides where inside the month to
   * draw the line, and changes nothing about the month's total.
   *
   * Hand-computed for January 2026 at 0,42 % across 31 days:
   *   daily = 1,0042^(1/31) − 1
   *   and by construction (1 + daily)^31 = 1,0042, so accumulating every
   *   interpolated day across the whole month returns **exactly 0,0042** once
   *   quantised at RATE_SCALE.
   */
  it('spreads a month geometrically and accumulates back to the published month', () => {
    const daily = interpolateMonthlyToDaily(points([['2026-01-01', '0.42']]));
    expect(daily).toHaveLength(31);

    const line = unwrap(accumulateRateSeries('IPCA', daily, day('2026-01-01'), day('2026-02-01')));
    expect(line.returnRate.toString()).toBe('0.0042');
  });

  it('uses the real length of each month, February included', () => {
    // 2026 is not a leap year, so February has 28 days and each of them carries
    // a larger share of the month than a January day would.
    const february = interpolateMonthlyToDaily(points([['2026-02-01', '0.42']]));
    expect(february).toHaveLength(28);
    expect(february[0]?.date).toBe('2026-02-01');
    expect(february[27]?.date).toBe('2026-02-28');

    const january = interpolateMonthlyToDaily(points([['2026-01-01', '0.42']]));
    // Same month, fewer days to spread it over → a bigger daily rate.
    expect(february[0]!.value.comparedTo(january[0]!.value)).toBe(1);
  });

  it('spreads several months in sequence', () => {
    // Jan 0,42 % then Feb 0,83 %:
    //   1,0042 × 1,0083 = 1 + 0,0042 + 0,0083 + 0,00003486 = **1,01253486**
    const daily = interpolateMonthlyToDaily(
      points([
        ['2026-01-01', '0.42'],
        ['2026-02-01', '0.83'],
      ]),
    );
    expect(daily).toHaveLength(31 + 28);

    const line = unwrap(accumulateRateSeries('IPCA', daily, day('2026-01-01'), day('2026-03-01')));
    expect(line.returnRate.toString()).toBe('0.01253486');
  });
});

describe('SPEC-012 BR-012-11 — "% do CDI" (AC-10)', () => {
  /**
   * The spec's own example, hand-computed end to end.
   *
   * One published CDI day at 0,05 % gives an accumulation of 1,0005 over the
   * period, so the benchmark returned 0,0005. A portfolio that returned 0,00059
   * over the same window is
   *
   *   0,00059 ÷ 0,0005 × 100 = 1,18 × 100 = **118 % do CDI**
   */
  it('is correct against a hand-computed CDI accumulation', () => {
    const line = unwrap(
      accumulateRateSeries(
        'CDI',
        points([['2026-03-02', '0.05']]),
        day('2026-03-02'),
        day('2026-03-03'),
      ),
    );
    expect(line.returnRate.toString()).toBe('0.0005');

    const percent = unwrap(percentOfCdi(Rate.of('0.00059'), line.returnRate));
    expect(percent.toString()).toBe('118');
  });

  it('expresses underperformance as a percentage below one hundred', () => {
    // 0,0004 ÷ 0,0005 × 100 = 0,8 × 100 = 80
    expect(unwrap(percentOfCdi(Rate.of('0.0004'), Rate.of('0.0005'))).toString()).toBe('80');
  });

  it('refuses a CDI accumulation of zero', () => {
    expect(errorCode(percentOfCdi(Rate.of('0.02'), Rate.zero()))).toBe(
      'PERFORMANCE_BENCHMARK_NOT_POSITIVE',
    );
  });

  it('refuses a negative CDI accumulation, which would invert the comparison', () => {
    // A portfolio down 1 % against a benchmark down 2 % would otherwise report
    // "50 % do CDI", which reads as underperformance and is the opposite of the
    // truth.
    expect(errorCode(percentOfCdi(Rate.of('-0.01'), Rate.of('-0.02')))).toBe(
      'PERFORMANCE_BENCHMARK_NOT_POSITIVE',
    );
  });
});

describe('SPEC-012 BR-012-13 — real (IPCA-adjusted) return (AC-12)', () => {
  /**
   * Fisher, hand-computed:
   *
   *   (1 + 0,12) ÷ (1 + 0,05) − 1 = 1,12 ÷ 1,05 − 1
   *                                = 1,0666666666…6 − 1
   *                                = 0,0666666666…6
   *                                → **0,066666666667** at RATE_SCALE
   *
   * Note it is *not* 0,07. Subtracting the rates overstates the real return by
   * their product, which over a decade is a materially different answer to
   * "did my money actually grow".
   */
  it('deflates nominal by inflation rather than subtracting it', () => {
    const real = unwrap(realReturn(Rate.of('0.12'), Rate.of('0.05')));
    expect(real.toString()).toBe('0.066666666667');
    expect(real.toDecimal().lessThan('0.07')).toBe(true);
  });

  it('reports a real loss where inflation outran the portfolio', () => {
    // (1 + 0,03) ÷ (1 + 0,05) − 1 = 1,03 ÷ 1,05 − 1 = −0,019047619047…
    //   → −0,019047619048 (the 13th digit is 6, so the 12th rounds away from zero)
    const real = unwrap(realReturn(Rate.of('0.03'), Rate.of('0.05')));
    expect(real.toString()).toBe('-0.019047619048');
  });

  it('refuses a deflator of zero', () => {
    expect(errorCode(realReturn(Rate.of('0.12'), Rate.of('-1')))).toBe(
      'PERFORMANCE_DEFLATOR_DEGENERATE',
    );
  });
});

describe('SPEC-012 BR-012-12 — the shadow portfolio (AC-11)', () => {
  const line: BenchmarkLine = {
    benchmark: 'CDI',
    points: [
      { date: day('2026-03-02'), factor: Rate.of('1') },
      { date: day('2026-03-03'), factor: Rate.of('1.01') },
      { date: day('2026-03-04'), factor: Rate.of('1.0201') },
    ],
    returnRate: Rate.of('0.0201'),
  };

  /**
   * Hand-computed, and this is the whole behaviour BR-012-12 asks for — the
   * user's **own** dates and amounts, growing at someone else's rate:
   *
   *   02/03  1.000,00                        (the opening value)
   *   03/03  1.000 × 1,01 + 500 = 1.510,00   (the deposit earns nothing on arrival)
   *   04/03  1.510 × 1,01      = 1.525,10
   */
  it('applies the user’s actual flow dates and amounts at the benchmark’s rate', () => {
    const flows: readonly DatedFlow[] = [{ date: day('2026-03-03'), amount: money('500') }];
    const shadow = shadowPortfolio(line, money('1000'), flows);

    expect(shadow.points.map((point) => point.value.toString())).toEqual([
      '1000',
      '1510',
      '1525.1',
    ]);
    expect(shadow.finalValue.toString()).toBe('1525.1');
    expect(shadow.benchmark).toBe('CDI');
  });

  it('moves the answer when the same deposit arrives on a different date', () => {
    // The same 500 arriving a day later misses one 1 % day:
    //   02/03  1.000
    //   03/03  1.000 × 1,01           = 1.010
    //   04/03  1.010 × 1,01 + 500     = 1.020,10 + 500 = 1.520,10
    const shadow = shadowPortfolio(line, money('1000'), [
      { date: day('2026-03-04'), amount: money('500') },
    ]);
    expect(shadow.finalValue.toString()).toBe('1520.1');
  });

  it('sums several flows landing on the same date', () => {
    // 300 + 200 on the 3rd is the 500 above.
    const shadow = shadowPortfolio(line, money('1000'), [
      { date: day('2026-03-03'), amount: money('300') },
      { date: day('2026-03-03'), amount: money('200') },
    ]);
    expect(shadow.finalValue.toString()).toBe('1525.1');
  });

  it('treats a day whose benchmark factor is zero as flat rather than throwing', () => {
    // Only a broken level row can produce a zero factor. Losing one day of the
    // comparison is better than losing the whole line — and better still than
    // dividing by zero.
    const broken: BenchmarkLine = {
      benchmark: 'IBOV',
      points: [
        { date: day('2026-03-02'), factor: Rate.of('1') },
        { date: day('2026-03-03'), factor: Rate.zero() },
        { date: day('2026-03-04'), factor: Rate.of('1.5') },
      ],
      returnRate: Rate.of('0.5'),
    };
    const shadow = shadowPortfolio(broken, money('1000'), []);
    // 1.000 × (0 ÷ 1) = 0 on the 3rd; the 4th cannot divide by that, so it
    // holds flat at 0 rather than failing.
    expect(shadow.points.map((point) => point.value.toString())).toEqual(['1000', '0', '0']);
  });
});
