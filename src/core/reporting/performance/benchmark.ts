import Decimal from 'decimal.js';
import { BusinessDate } from '@/core/shared/clock';
import { domainError } from '@/core/shared/domain-error';
import { Money, Quantity } from '@/core/shared/money';
import { err, ok } from '@/core/shared/result';
import { daysInMonth } from '@/core/reporting/period';
import { listCalendarDays } from '@/core/valuation/business-days';
import {
  PerformanceErrorCode,
  Rate,
  factorToReturn,
  growthFactor,
  percentToRate,
  quantizeRate,
  type Benchmark,
  type BenchmarkLine,
  type BenchmarkPoint,
  type DatedFlow,
  type IndexSeriesPoint,
  type PerformanceResult,
  type ShadowPortfolio,
  type ShadowPortfolioPoint,
} from '@/core/reporting/performance/ports';

/**
 * SPEC-012 BR-012-10..14 — **benchmarks: CDI, IPCA and IBOV.**
 *
 * Two presentations of each, and DL-012-04 is explicit that both are needed:
 * the **pure index line** is the correct basis for the headline TWR comparison,
 * because it is what the index did independent of what the user did; the
 * **shadow portfolio** receives the user's real cash flows on their real dates
 * at the benchmark's rate, which is what makes "what if I had just left it in
 * CDI?" intuitive. Each is misleading as the sole view.
 *
 * **The three series are not the same kind of number**, which is why there are
 * two accumulators rather than one:
 *
 *  - **CDI** (BCB SGS 12) publishes a *rate per business day*, in percent.
 *  - **IPCA** (BCB SGS 433) publishes a *rate per month*, in percent, dated the
 *    first of the month it measures.
 *  - **IBOV** comes from the quote provider as an index *level*.
 *
 * A rate compounds; a level divides. Feeding one to the other's accumulator
 * produces a number that looks like a percentage and is nothing of the sort.
 */

const HUNDRED = Quantity.fromString('100');

/**
 * BR-012-13 — the cumulative line for a **rate** series (CDI, IPCA).
 *
 * `factor(X) = Π (1 + v_d/100)` over published points with `from ≤ d < X`, so
 * the line starts at exactly 1 on `from` and the period's return is the last
 * factor less one.
 *
 * **The half-open window is the CETIP convention and matches
 * `core/valuation/accrual.ts` exactly.** SGS 12's value for day `d` is the rate
 * that applied *during* day `d`, so money present at the start of `d` earns it
 * and money that arrives at the close of `d` does not. A CDB issued Monday and
 * valued Tuesday accrues Monday's CDI and one day of it — the same arithmetic,
 * for the same reason. Two different windows in one codebase would put the
 * benchmark line and the fixed-income accrual a day out of step with each
 * other, which no user could see and every reconciliation would trip over.
 *
 * A business day with no published point does not compound, exactly as
 * `accrual.ts` treats it: BCB publishes today's CDI tomorrow, and a guessed
 * rate would be indistinguishable from a real one.
 *
 * Worked example (DV-17), hand-computed — two days at 0,04 % and 0,06 %:
 *
 *   factor = (1 + 0,0004) × (1 + 0,0006)
 *          = 1,0004 × 1,0006
 *          = 1 + 0,0004 + 0,0006 + 0,00000024
 *          = **1,00100024**            → a period return of 0,100024 %
 */
export function accumulateRateSeries(
  benchmark: Benchmark,
  points: readonly IndexSeriesPoint[],
  from: BusinessDate,
  to: BusinessDate,
): PerformanceResult<BenchmarkLine> {
  const dates = listCalendarDays(from, to);
  if (dates.length === 0) {
    return err(domainError(PerformanceErrorCode.BENCHMARK_SERIES_EMPTY, { benchmark, from, to }));
  }

  const byDate = new Map<BusinessDate, Quantity>(points.map((point) => [point.date, point.value]));

  const line: BenchmarkPoint[] = [];
  let factor = Rate.one();
  let published = 0;
  for (const date of dates) {
    // Recorded **before** this date's own rate is applied. That is what makes
    // the point on `from` exactly 1 and the point on `to` the accumulation over
    // `[from, to)` — the half-open window argued for above. Applying the rate
    // first would give the line an extra day at both ends and put it
    // permanently one business day ahead of `accrual.ts`'s figures.
    line.push({ date, factor: quantizeRate(factor) });
    const rate = byDate.get(date);
    if (rate !== undefined) {
      factor = factor.times(growthFactor(percentToRate(rate)));
      published += 1;
    }
  }

  if (published === 0) {
    /**
     * **No published point anywhere in the window is unavailable, not zero.**
     *
     * A missing *day* inside a populated window is BCB's ordinary publication
     * lag and simply does not compound (the branch above). A window with
     * nothing in it at all is a different fact — the series was never synced,
     * or the period predates it — and returning the empty product would draw a
     * perfectly flat CDI line beside a moving portfolio. That reads as "CDI did
     * nothing", which is a claim about the economy rather than an admission
     * about the data, and it would make "% do CDI" divide by zero one step
     * later.
     */
    return err(domainError(PerformanceErrorCode.BENCHMARK_SERIES_EMPTY, { benchmark, from, to }));
  }

  return ok(finishLine(benchmark, line));
}

/**
 * BR-012-13 — the cumulative line for a **level** series (IBOV).
 *
 * `factor(X) = level(X) / level(from)`, carrying the last observed level
 * forward across days the market did not trade. The baseline is the last level
 * on or before `from`, which is what makes a period starting on a Saturday or a
 * holiday produce a line beginning at 1 rather than no line at all.
 */
export function accumulateLevelSeries(
  benchmark: Benchmark,
  points: readonly IndexSeriesPoint[],
  from: BusinessDate,
  to: BusinessDate,
): PerformanceResult<BenchmarkLine> {
  const dates = listCalendarDays(from, to);
  const baseline = lastOnOrBefore(points, from);
  if (dates.length === 0 || baseline === null || !baseline.isPositive()) {
    // No level to divide by is not a zero return — it is no comparison at all.
    // A zero here would render a flat benchmark line beside a moving portfolio,
    // which reads as "the index did nothing" rather than "the index is unknown".
    return err(domainError(PerformanceErrorCode.BENCHMARK_SERIES_EMPTY, { benchmark, from, to }));
  }

  const byDate = new Map<BusinessDate, Quantity>(points.map((point) => [point.date, point.value]));

  const line: BenchmarkPoint[] = [];
  let level = baseline;
  for (const date of dates) {
    const published = byDate.get(date);
    // BR-009-03's carry-forward, applied to an index: a weekend or a holiday
    // holds the last observed level rather than dropping out of the line.
    if (published !== undefined) level = published;
    line.push({ date, factor: quantizeRate(level.dividedBy(baseline)) });
  }

  return ok(finishLine(benchmark, line));
}

/**
 * The period's return is read **off the last point of the line**, never
 * accumulated separately. Two figures derived by two routes are two figures
 * that can disagree, and a chart whose last point does not match the headline
 * beside it is the kind of defect a user reports as "the numbers are wrong"
 * without being able to say which one.
 */
function finishLine(benchmark: Benchmark, points: readonly BenchmarkPoint[]): BenchmarkLine {
  // Non-null: every caller has already rejected an empty date range.
  const last = points[points.length - 1] as BenchmarkPoint;
  return { benchmark, points, returnRate: factorToReturn(last.factor) };
}

function lastOnOrBefore(points: readonly IndexSeriesPoint[], date: BusinessDate): Quantity | null {
  let found: Quantity | null = null;
  for (const point of [...points].sort((a, b) => BusinessDate.compare(a.date, b.date))) {
    if (BusinessDate.isAfter(point.date, date)) break;
    found = point.value;
  }
  return found;
}

/**
 * BR-012-13 — **IPCA, monthly, interpolated to a daily series.**
 *
 * A monthly index cannot be charted beside a daily portfolio without deciding
 * what it did *inside* the month, and the decision here is the neutral one:
 * spread each month's factor geometrically across that month's calendar days,
 * so `(1 + daily)^days = (1 + monthly)` exactly. The alternative — a step
 * function that jumps on the first of each month — would put a visible cliff in
 * the chart on a date where nothing actually happened to prices.
 *
 * A published IPCA point is dated the **first of the month it measures**, which
 * is the SGS 433 convention, so the interpolation runs from that date through
 * that month's last day.
 *
 * **This is display interpolation, and the accumulated total is unchanged by
 * it**: compounding the interpolated daily rates across a whole month returns
 * that month's published figure, which is the property the test asserts. It
 * does not invent inflation the index did not report; it only decides where
 * inside the month to draw it.
 *
 * Worked example (DV-17) — January 2026 at 0,42 %:
 *
 *   daily = (1,0042) ^ (1/31) − 1 = 0,000135258… → 0,0135258… % per day
 *   check = (1 + 0,000135258…) ^ 31 = **1,0042**   (the published month, exactly)
 */
export function interpolateMonthlyToDaily(
  points: readonly IndexSeriesPoint[],
): readonly IndexSeriesPoint[] {
  const daily: IndexSeriesPoint[] = [];
  for (const point of points) {
    const [year, month] = point.date.split('-').map(Number) as [number, number, number];
    const days = daysInMonth(year, month);
    const monthlyFactor = growthFactor(percentToRate(point.value));
    // The `pow` is why `Decimal` is touched directly here — see `accrual.ts`'s
    // `powFactor` for the same reasoning: money is never raised to a power, a
    // rate legitimately is, and the value crosses back as a decimal string so
    // no JS `number` can enter (AR-06).
    const dailyFactor = Quantity.fromString(
      monthlyFactor.toDecimal().pow(new Decimal(1).dividedBy(days)).toFixed(),
    );
    const dailyPercent = factorToReturn(dailyFactor).times(HUNDRED);

    const first = point.date;
    const last = BusinessDate.of(`${first.slice(0, 8)}${String(days).padStart(2, '0')}`);
    for (const date of listCalendarDays(first, last)) {
      daily.push({ date, value: dailyPercent });
    }
  }
  return daily;
}

/**
 * BR-012-11 / DL-012-05 — **"% do CDI"**, a first-class figure.
 *
 * `100 × portfolio return ÷ CDI return`. It is the idiom Brazilian investors
 * already think in, and expressing the comparison any other way — "3,2 pontos
 * acima do CDI" — forces a mental translation on every read.
 *
 * **A non-positive CDI accumulation has no percentage of it**, and the refusal
 * is not pedantry. Divided by zero the figure is infinite; divided by a
 * negative one it *inverts*, so a portfolio that lost less than the benchmark
 * would report a comfortable "140 % do CDI". CDI has never been negative over
 * any real window, which is exactly why nobody would look for the bug.
 *
 * Worked example (DV-17): a portfolio up 0,20 % over two days in which CDI
 * accumulated 0,100024 % →
 *
 *   0,002 ÷ 0,00100024 = 1,99952003… → **199,95 % do CDI**
 */
export function percentOfCdi(portfolioReturn: Rate, cdiReturn: Rate): PerformanceResult<Quantity> {
  if (!cdiReturn.isPositive()) {
    return err(
      domainError(PerformanceErrorCode.BENCHMARK_NOT_POSITIVE, {
        cdiReturn: cdiReturn.toString(),
      }),
    );
  }
  return ok(quantizeRate(portfolioReturn.dividedBy(cdiReturn).times(HUNDRED)));
}

/**
 * BR-012-13 — **real (IPCA-adjusted) return.**
 *
 * `(1 + nominal) / (1 + inflation) − 1`, the Fisher relation. Subtracting the
 * two rates is the common shortcut and it is wrong by their product: 12 %
 * nominal against 5 % inflation is 6,67 % real, not 7 %. Over a decade that
 * error compounds into a materially different picture of whether the money
 * actually grew.
 *
 * Worked example (DV-17):
 *
 *   (1 + 0,12) ÷ (1 + 0,05) − 1 = 1,12 ÷ 1,05 − 1
 *                                = 1,0666666666…6 − 1
 *                                = **0,066666666667** (quantised at RATE_SCALE)
 */
export function realReturn(nominal: Rate, inflation: Rate): PerformanceResult<Rate> {
  const deflator = growthFactor(inflation);
  if (!deflator.isPositive()) {
    // Prices having fallen to nothing is not a real return, it is a broken
    // index series. Either way there is no meaningful figure to publish.
    return err(
      domainError(PerformanceErrorCode.DEFLATOR_DEGENERATE, { inflation: inflation.toString() }),
    );
  }
  return ok(quantizeRate(factorToReturn(growthFactor(nominal).dividedBy(deflator))));
}

/**
 * BR-012-12 / DL-012-04 — **the shadow portfolio.**
 *
 * The user's actual cash flows, on their actual dates, growing at the
 * benchmark's rate instead of at their portfolio's:
 *
 *   `value(d) = value(d−1) × factor(d)/factor(d−1) + flow(d)`
 *
 * **Flows land at the end of the day**, exactly as `twr.ts` assumes, so a
 * deposit made on day `d` earns the benchmark from day `d+1`. Any other choice
 * would make the shadow and the portfolio it is drawn against answer slightly
 * different questions, and the whole value of the line is that it answers the
 * same one.
 *
 * Worked example (DV-17) — R$ 1.000,00 opening, a benchmark day of +1 %, then
 * a further R$ 500,00 deposited that day and another +1 % day:
 *
 *   d0: 1.000,00                       (the opening value)
 *   d1: 1.000 × 1,01 + 500 = 1.510,00  (the deposit earns nothing on arrival)
 *   d2: 1.510 × 1,01        = 1.525,10
 *
 * Against a real portfolio that ended at, say, R$ 1.600,00, the shadow says the
 * same contributions in CDI would have been worth R$ 1.525,10 — which is the
 * comparison the user actually has in mind.
 */
export function shadowPortfolio(
  line: BenchmarkLine,
  openingValue: Money,
  flows: readonly DatedFlow[],
): ShadowPortfolio {
  const flowsByDate = new Map<BusinessDate, Money>();
  for (const flow of flows) {
    flowsByDate.set(flow.date, (flowsByDate.get(flow.date) ?? Money.zero()).plus(flow.amount));
  }

  const points: ShadowPortfolioPoint[] = [];
  let value = openingValue;
  let previousFactor: Rate | null = null;
  for (const point of line.points) {
    if (previousFactor !== null) value = value.times(stepGrowth(previousFactor, point.factor));
    // BR-012-12: the user's own flow, on the user's own date. The line supplies
    // only the rate — never the timing, and never the amount.
    value = value.plus(flowsByDate.get(point.date) ?? Money.zero());
    points.push({ date: point.date, value });
    previousFactor = point.factor;
  }

  return {
    benchmark: line.benchmark,
    points,
    // Non-null: `BenchmarkLine` is only ever built from a non-empty date range.
    finalValue: (points[points.length - 1] as ShadowPortfolioPoint).value,
  };
}

/**
 * One day's growth, as the ratio of consecutive cumulative factors.
 *
 * A factor of zero can only arise from a **level** series that published a zero
 * — a broken IBOV row, not a market that fell to nothing. Dividing by it would
 * throw; treating the day as flat keeps the rest of the line intact and leaves
 * the anomaly visible in the chart, rather than replacing the whole comparison
 * with an error because one row was bad.
 */
function stepGrowth(previous: Rate, current: Rate): Rate {
  return previous.isPositive() ? current.dividedBy(previous) : Rate.one();
}
