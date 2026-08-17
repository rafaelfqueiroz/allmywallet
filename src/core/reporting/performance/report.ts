import { BusinessDate } from '@/core/shared/clock';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import type { Quantity } from '@/core/shared/money';
import { Money, sumMoney } from '@/core/shared/money';
import { err, ok, type Result } from '@/core/shared/result';
import { addCalendarDays } from '@/core/valuation/business-days';
import { runReportQuery } from '@/core/reporting/base-query';
import type { ResolvedScope } from '@/core/reporting/scope';
import type {
  DailyValuationSnapshot,
  DateRange,
  Grouping,
  Period,
  ReportDataPort,
  ReportingErrorCode,
  Scope,
} from '@/core/reporting/ports';
import {
  accumulateLevelSeries,
  accumulateRateSeries,
  interpolateMonthlyToDaily,
  percentOfCdi,
  realReturn,
  shadowPortfolio,
} from '@/core/reporting/performance/benchmark';
import { decomposeContributions } from '@/core/reporting/performance/contribution';
import { computeTwr } from '@/core/reporting/performance/twr';
import { computeXirr, divergesMaterially } from '@/core/reporting/performance/xirr';
import {
  EarningsTreatment,
  PerformanceErrorCode,
  type Benchmark,
  type BenchmarkLine,
  type CashFlow,
  type ContributionReport,
  type DatedFlow,
  type IndexSeriesReaderPort,
  type PerformanceResult,
  type Rate,
  type SeriesPoint,
  type ShadowPortfolio,
  type TwrResult,
  type XirrResult,
} from '@/core/reporting/performance/ports';

/**
 * SPEC-012 — the Performance Report, assembled.
 *
 * BR-011-13 / TS-32: every figure comes from `daily_valuation_snapshots` (via
 * `ReportDataPort`), the SPEC-007 position cache and the shared `index_series`
 * table. Nothing here reaches the append-only ledger — the whole reason the
 * snapshot cache exists is so a report never replays five years of it per
 * request (DL-011-07).
 *
 * ## Why the measures are `Result`s *inside* a successful report
 *
 * BR-012-05 and BR-012-18 both require a measure to be reportable as
 * unavailable, and a report in which one measure is unavailable is still a
 * report worth rendering: a non-convergent XIRR does not invalidate the TWR
 * beside it, and a missing IPCA series does not invalidate the CDI line. So the
 * outer `Result` fails only for the framework's own reasons — a period typed
 * backwards, a scope naming a wallet this tenant does not have — and each
 * measure carries its own outcome. The UI renders what exists and names what
 * does not, which is what "honest over impressive" means here.
 */

// ---------------------------------------------------------------------------
// Turning snapshots into a series (BR-012-06..08)
// ---------------------------------------------------------------------------

export interface PerformanceSeries {
  readonly points: readonly SeriesPoint[];
  /** BR-012-01: external flows, signed positive into the portfolio. */
  readonly flows: readonly DatedFlow[];
  /** BR-012-06: proventos recognised inside the period, at pay date. */
  readonly earningsInPeriod: Money;
  /** `endValue − beginValue − Σ flows` — the money the period actually made. */
  readonly gain: Money;
}

/**
 * BR-012-06/07/08 — the value series and the flow series, for one earnings
 * treatment.
 *
 * **Flows are the *differences* of the snapshot's cumulative totals**, dated at
 * the later snapshot. The first snapshot contributes none: its value already
 * includes every trade made on or before that date (SPEC-009 values a date by
 * replaying to and including it), so counting its flow again would double it.
 * That is the same half-open `(from, to]` convention `twr.ts` and
 * `modified-dietz.ts` are built on.
 *
 * ## How earnings enter, and why they are a flow rather than a value
 *
 * DL-012-03 is explicit that proventos are **income received at pay date and
 * never assumed reinvested** — assuming reinvestment would invent transactions
 * the user never made, and the money frequently went to their bank.
 *
 * There are two ways to honour that and only one of them is right:
 *
 *  - Hold the earnings as idle cash inside the portfolio's value. The dividend
 *    then shows up as a gain on pay date, but every *subsequent* day's return
 *    is diluted by cash that is not invested in anything. A portfolio worth
 *    1.000 that pays 10 and then rises 10 % would report 9,9 %.
 *  - **Treat the payment as money leaving the portfolio** — a negative external
 *    flow on pay date. The dividend still shows up as a gain (the numerator
 *    subtracts a negative flow), and the following day's base is the 990 that
 *    is actually invested, so the same portfolio reports the 10 % it earned.
 *
 * The second is what this does, and it is also what makes the two measures
 * agree with each other: XIRR sees the same payment as cash back to the user on
 * the same date, which is precisely what it is.
 *
 * "Without earnings" (BR-012-07) leaves the payment out of the flows entirely,
 * so the ex-date price fall stays in the value series with nothing to offset
 * it — which is exactly what price return means.
 */
export function seriesFromSnapshots(
  snapshots: readonly DailyValuationSnapshot[],
  treatment: EarningsTreatment,
): PerformanceSeries {
  const points: SeriesPoint[] = snapshots.map((snapshot) => ({
    date: snapshot.date,
    value: snapshot.totalValue,
  }));

  const flows: DatedFlow[] = [];
  let earnings = Money.zero();
  for (let index = 1; index < snapshots.length; index += 1) {
    // Non-null: `index` runs strictly inside the array's bounds.
    const previous = snapshots[index - 1] as DailyValuationSnapshot;
    const current = snapshots[index] as DailyValuationSnapshot;
    const external = current.netContributions.minus(previous.netContributions);
    const paid = current.earningsToDate.minus(previous.earningsToDate);
    earnings = earnings.plus(paid);
    flows.push({
      date: current.date,
      amount: treatment === EarningsTreatment.WITH_EARNINGS ? external.minus(paid) : external,
    });
  }

  const opening = points[0]?.value ?? Money.zero();
  const closing = points[points.length - 1]?.value ?? Money.zero();
  return {
    points,
    flows,
    earningsInPeriod: earnings,
    gain: closing.minus(opening).minus(sumMoney(flows.map((flow) => flow.amount))),
  };
}

/**
 * SPEC-012 BR-012-01/03 — **the period's baseline, prepended to its
 * observations.**
 *
 * A `daily_valuation_snapshots` row dated `d` is the **close** of `d`: SPEC-009
 * values a date by replaying the ledger to and including it. So the snapshots
 * inside `[from, to]` open on the close of `from`, and a series built from them
 * alone measures from the *end* of the period's first day — every movement
 * during `from` itself, price and flow alike, falls outside the return.
 *
 * That is the same off-by-one SPEC-013 BR-013-02 already fixes for
 * *Patrimônio*, which is exactly why it had to be fixed here: the two screens
 * were reporting the same range from different starting points, and disagreeing
 * about it. A custom range whose first day gained 5 % showed +5 % growth on
 * Patrimônio and a TWR of 0,00 % on Rentabilidade.
 *
 * Prepending the preceding snapshot makes the first sub-period span
 * `close(before) → close(from)`, which is the day `from`. **The flow alignment
 * follows from it rather than needing its own rule**: `seriesFromSnapshots`
 * derives flows as differences of the cumulative `net_contributions`, so a
 * contribution made on `from` becomes the difference between the baseline's
 * total and `from`'s — one flow, dated `from`, inside the one sub-period that
 * ends there. Neither dropped (as it was before, the first snapshot
 * contributing no flow) nor counted twice.
 *
 * **The baseline is a baseline, not a series.** With no snapshot inside the
 * period there is nothing to measure *to*, and a lone prior point would link no
 * sub-periods and publish a confident 0 % — precisely the misleading zero
 * BR-012-18 forbids. So it is used only alongside real observations.
 *
 * `null` when the period starts at or before the tenant's first snapshot. The
 * period genuinely opens with the portfolio's first recorded value there, and
 * that behaviour is unchanged.
 */
export function baselineFor(
  opening: DailyValuationSnapshot | null,
  snapshots: readonly DailyValuationSnapshot[],
): DailyValuationSnapshot | null {
  return snapshots.length === 0 ? null : opening;
}

/**
 * BR-012-03 — the same period, in the **investor's** sign convention.
 *
 * The inversion happens here and nowhere else. A buy is money the user parted
 * with (negative); a sell or a dividend is money that came back (positive); the
 * opening value is capital they already had committed (negative) and the
 * closing value is what they would have if they stopped today (positive).
 *
 * Both endpoints are required. Without the opening value, a period that starts
 * mid-history would look as though the user began with nothing, and every
 * return over a 12-month window on a ten-year portfolio would be wrong by the
 * whole of its opening *patrimônio*.
 *
 * The first point is the **baseline** where one exists (`baselineFor` above),
 * so XIRR discounts from the same opening capital TWR measures from. It needed
 * that correction as much as TWR did — before it, the first flow was the close
 * of `from`, which already contained both the first day's gain and any
 * contribution made that day, so the two cancelled and the day vanished from
 * the money-weighted return too.
 */
export function cashFlowsFrom(series: PerformanceSeries): readonly CashFlow[] {
  const first = series.points[0];
  const last = series.points[series.points.length - 1];
  if (first === undefined || last === undefined) return [];

  return [
    { date: first.date, amount: first.value.negated() },
    ...series.flows.map((flow) => ({ date: flow.date, amount: flow.amount.negated() })),
    { date: last.date, amount: last.value },
  ];
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface PerformanceReportDependencies {
  readonly port: ReportDataPort;
  /** AR-15: `index_series` is shared reference data — no tenant context. */
  readonly indexSeries: IndexSeriesReaderPort;
}

export interface PerformanceReportInput {
  readonly period: Period;
  readonly scope: Scope;
  readonly grouping: Grouping;
  /** `Clock.today()` — passed in, never read ambiently (AR-03, AR-29). */
  readonly today: BusinessDate;
  /** BR-012-09: both views available for every scope, period and grouping. */
  readonly treatment: EarningsTreatment;
  /** BR-012-14: the user's `reports.benchmarks` preference (SPEC-002). */
  readonly benchmarks: readonly Benchmark[];
  /** BR-012-04: how far apart TWR and XIRR must be before the gap is explained. */
  readonly divergencePoints: Quantity;
  /** The `all` period's anchor — the first date this tenant has a snapshot for. */
  readonly earliest: BusinessDate | null;
}

export interface BenchmarkOutcome {
  readonly benchmark: Benchmark;
  /** BR-012-12: the pure index line. */
  readonly line: PerformanceResult<BenchmarkLine>;
  /** BR-012-12: the same rate, receiving the user's actual flows. */
  readonly shadow: ShadowPortfolio | null;
}

export interface PerformanceReport {
  readonly range: DateRange;
  readonly scope: ResolvedScope;
  readonly grouping: Grouping;
  readonly treatment: EarningsTreatment;
  readonly series: PerformanceSeries;
  /** BR-012-01/02 — with its Modified Dietz disclosure attached. */
  readonly twr: PerformanceResult<TwrResult>;
  /** BR-012-03/05 — or the reason there is no root. */
  readonly xirr: PerformanceResult<XirrResult>;
  /** BR-012-04 / DL-012-02: render the inline explanation of the gap. */
  readonly explainDivergence: boolean;
  readonly benchmarks: readonly BenchmarkOutcome[];
  /** BR-012-11: "118 % do CDI", as a percentage. */
  readonly percentOfCdi: PerformanceResult<Quantity>;
  /** BR-012-13: the IPCA-adjusted return. */
  readonly realReturn: PerformanceResult<Rate>;
  /** BR-012-15/16 — decomposed on cost basis; see `contribution.ts`. */
  readonly contribution: PerformanceResult<ContributionReport>;
  /** BR-012-18 / BR-011-16: the scope holds nothing — an empty state. */
  readonly empty: boolean;
}

export async function runPerformanceReport(
  deps: PerformanceReportDependencies,
  input: PerformanceReportInput,
): Promise<Result<PerformanceReport, DomainError<ReportingErrorCode>>> {
  const base = await runReportQuery(
    deps.port,
    {
      period: input.period,
      scope: input.scope,
      grouping: input.grouping,
      today: input.today,
    },
    input.earliest,
  );
  if (!base.ok) return base;

  // SPEC-012 BR-012-01: the period's return runs from the close *before* it, so
  // the first day belongs to the report rather than to the day before it. Read
  // only once the range is resolved — the date it needs is `range.from`, which
  // `resolvePeriod` inside `runReportQuery` is what decides. Same tenant
  // transaction, same consistent view (AR-11); `patrimonio/data.ts` sequences
  // the identical read for the identical reason.
  const baseline = baselineFor(
    await deps.port.findSnapshotBefore(base.value.range.from),
    base.value.snapshots,
  );
  const series = seriesFromSnapshots(
    baseline === null ? base.value.snapshots : [baseline, ...base.value.snapshots],
    input.treatment,
  );

  /**
   * SPEC-012 BR-012-12/13 — **the benchmark window is the series window, not
   * the requested period.**
   *
   * `accumulateRateSeries` starts its line at exactly 1 on its `from` and
   * compounds the published rates over `[from, to)`, so its return is the
   * growth of capital present from `from`'s open — i.e. from the close of the
   * day before. That is now precisely where the portfolio's series starts, and
   * the two must cover the same days or "% do CDI" divides a 32-day portfolio
   * return by a 31-day CDI one (BR-012-11) and the comparison chart's first row
   * shows the portfolio moving against a benchmark still pinned at 100.
   *
   * With no baseline the window is the period, unchanged.
   */
  const seriesRange: DateRange =
    baseline === null ? base.value.range : { from: baseline.date, to: base.value.range.to };

  /**
   * AC-16 — **wallet scope has no series behind it, and that is reported
   * rather than approximated.**
   *
   * `daily_valuation_snapshots` is persisted at portfolio grain: one row per
   * user per day, with no wallet dimension (SPEC-009 BR-009-16). A wallet's
   * time-weighted return therefore has no daily value series and no daily flow
   * series to link, and the only figures that could be substituted — the
   * portfolio's — would attach one wallet's name to the whole *patrimônio*'s
   * return. That is the single most dangerous kind of wrong number this product
   * could show, because every figure in it would be real.
   *
   * The contribution breakdown below **does** work at wallet scope: it reads
   * the holding set, which is sliced per wallet by construction (SPEC-011
   * `buildHoldingSet`), so a wallet still gets its own return on cost and its
   * groups still reconcile.
   */
  const scoped = input.scope.kind === 'wallet';
  const twr: PerformanceResult<TwrResult> = scoped
    ? err(
        domainError(PerformanceErrorCode.SCOPE_SERIES_UNAVAILABLE, {
          scope: 'wallet',
          measure: 'twr',
        }),
      )
    : computeTwr({ points: series.points, flows: series.flows });
  const xirr: PerformanceResult<XirrResult> = scoped
    ? err(
        domainError(PerformanceErrorCode.SCOPE_SERIES_UNAVAILABLE, {
          scope: 'wallet',
          measure: 'xirr',
        }),
      )
    : computeXirr({ flows: cashFlowsFrom(series) });

  const benchmarks = await loadBenchmarks(deps.indexSeries, input, seriesRange, series);
  const cdi = benchmarks.find((outcome) => outcome.benchmark === 'CDI');
  const ipca = benchmarks.find((outcome) => outcome.benchmark === 'IPCA');

  return ok({
    range: base.value.range,
    scope: base.value.scope,
    grouping: input.grouping,
    treatment: input.treatment,
    series,
    twr,
    xirr,
    // BR-012-04: only when both figures exist. Explaining the gap between a
    // number and an unavailable one is not an explanation.
    explainDivergence:
      twr.ok && xirr.ok
        ? divergesMaterially(twr.value.returnRate, xirr.value.rate, input.divergencePoints)
        : false,
    benchmarks,
    percentOfCdi: compareToBenchmark(twr, cdi, percentOfCdi),
    realReturn: compareToBenchmark(twr, ipca, realReturn),
    contribution: decomposeContributions(
      base.value.report.grouping,
      /**
       * BR-012-15/16 on the basis the position cache can actually answer:
       * `beginValue` is the group's cost basis (*preço médio* × quantity) and
       * the flow is zero, so each group's "own return" is its return on
       * invested capital and the contributions sum to the scope's. See
       * `contribution.ts` for why a decomposition of the *linked* TWR is not
       * available without a per-group daily series.
       */
      base.value.report.groups.map((group) => ({
        key: group.key,
        beginValue: group.totals.costBasis,
        endValue: group.totals.value,
        flow: Money.zero(),
      })),
    ),
    empty: base.value.empty,
  });
}

/** BR-012-10/14 — each selected benchmark, independently. */
async function loadBenchmarks(
  indexSeries: IndexSeriesReaderPort,
  input: PerformanceReportInput,
  range: DateRange,
  series: PerformanceSeries,
): Promise<readonly BenchmarkOutcome[]> {
  const outcomes: BenchmarkOutcome[] = [];
  for (const benchmark of input.benchmarks) {
    const line = await loadBenchmarkLine(indexSeries, benchmark, range);
    outcomes.push({
      benchmark,
      line,
      // BR-012-12: the shadow needs the user's opening value and their real
      // flows. With no series there is nothing to replay them into.
      shadow: line.ok
        ? shadowPortfolio(line.value, series.points[0]?.value ?? Money.zero(), series.flows)
        : null,
    });
  }
  return outcomes;
}

async function loadBenchmarkLine(
  indexSeries: IndexSeriesReaderPort,
  benchmark: Benchmark,
  range: DateRange,
): Promise<PerformanceResult<BenchmarkLine>> {
  if (benchmark === 'IBOV') {
    // A level series, and the baseline may predate the period — a period that
    // opens on a Saturday has no close of its own. Reaching back a fortnight
    // covers Carnaval, the longest stretch B3 is shut.
    const points = await indexSeries.listPoints('IBOV', addCalendarDays(range.from, -15), range.to);
    return accumulateLevelSeries(benchmark, points, range.from, range.to);
  }
  if (benchmark === 'IPCA') {
    // BR-012-13: SGS 433 is monthly, dated the first of the month it measures,
    // so the point covering the period's opening month starts before the
    // period does.
    const points = await indexSeries.listPoints('IPCA', startOfMonth(range.from), range.to);
    return accumulateRateSeries(benchmark, interpolateMonthlyToDaily(points), range.from, range.to);
  }
  const points = await indexSeries.listPoints('CDI', range.from, range.to);
  return accumulateRateSeries(benchmark, points, range.from, range.to);
}

/**
 * BR-012-11/13 — a comparison exists only where both sides of it do.
 *
 * Neither "% do CDI" nor a real return is meaningful against half a pair, and
 * inventing the missing half (a zero benchmark, a zero portfolio return) is how
 * a comparison ends up confidently backwards.
 */
function compareToBenchmark<T>(
  twr: PerformanceResult<TwrResult>,
  outcome: BenchmarkOutcome | undefined,
  compare: (portfolio: Rate, benchmark: Rate) => PerformanceResult<T>,
): PerformanceResult<T> {
  if (!twr.ok) return twr;
  if (outcome === undefined) {
    return err(
      domainError(PerformanceErrorCode.BENCHMARK_SERIES_EMPTY, { reason: 'not_selected' }),
    );
  }
  if (!outcome.line.ok) return outcome.line;
  return compare(twr.value.returnRate, outcome.line.value.returnRate);
}

/** The first of `date`'s month — SGS 433's own dating convention. */
function startOfMonth(date: BusinessDate): BusinessDate {
  return BusinessDate.of(`${date.slice(0, 8)}01`);
}
