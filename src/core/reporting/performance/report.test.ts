import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import type { AssetClass } from '@/core/quotes/ports';
import type { DailyValuationSnapshot } from '@/core/valuation/ports';
import {
  FakeReportDataPort,
  aPosition,
  anAsset,
  assetIdOf,
  walletIdOf,
} from '@/core/reporting/test-support';
import type { Period, Scope } from '@/core/reporting/ports';
import {
  cashFlowsFrom,
  runPerformanceReport,
  seriesFromSnapshots,
  type PerformanceReport,
} from '@/core/reporting/performance/report';
import { DEFAULT_DIVERGENCE_POINTS } from '@/core/reporting/performance/xirr';
import {
  EarningsTreatment,
  type Benchmark,
  type IndexSeriesCode,
  type IndexSeriesPoint,
  type IndexSeriesReaderPort,
} from '@/core/reporting/performance/ports';

/**
 * SPEC-012 — the Performance Report use case.
 *
 * TS-01/TS-02: no database, and the ports are implemented by hand-written
 * fakes. TS-04/TS-05: every expectation hand-computed, with the arithmetic in
 * the comment above it.
 */

const day = (value: string): BusinessDate => BusinessDate.of(value);
const money = (value: string): Money => Money.fromString(value);

const START = day('2026-01-01');
const MIDDLE = day('2026-07-01');
const END = day('2027-01-01');

function snapshot(
  date: string,
  totalValue: string,
  netContributions: string,
  earningsToDate: string,
): DailyValuationSnapshot {
  return {
    date: day(date),
    totalValue: money(totalValue),
    netContributions: money(netContributions),
    earningsToDate: money(earningsToDate),
    byAssetClass: new Map<AssetClass, Money>([['stock', money(totalValue)]]),
    hasEstimates: false,
  };
}

/** TS-02: a hand-written fake implementing the real port. */
class FakeIndexSeries implements IndexSeriesReaderPort {
  constructor(
    private readonly data: Partial<Record<IndexSeriesCode, readonly IndexSeriesPoint[]>>,
  ) {}

  async listPoints(
    code: IndexSeriesCode,
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<readonly IndexSeriesPoint[]> {
    return (this.data[code] ?? []).filter(
      (point) => !BusinessDate.isBefore(point.date, from) && !BusinessDate.isAfter(point.date, to),
    );
  }
}

/**
 * The fixture, chosen so every figure is exact by hand.
 *
 *   01/01/2026  value 100.000  contributions 100.000  proventos 0
 *   01/07/2026  value 110.000  contributions 100.000  proventos 0
 *   01/01/2027  value 109.000  contributions 100.000  proventos 1.000
 *
 * A portfolio that rose 10 %, then paid a R$ 1.000,00 dividend which took the
 * price down with it. There are no external flows at all after the opening
 * balance, which is what makes the two measures land on round numbers.
 */
const DIVIDEND_HISTORY: readonly DailyValuationSnapshot[] = [
  snapshot('2026-01-01', '100000', '100000', '0'),
  snapshot('2026-07-01', '110000', '100000', '0'),
  snapshot('2027-01-01', '109000', '100000', '1000'),
];

/**
 * The same portfolio with a R$ 500.000,00 deposit on 1 July that then sits
 * uninvested — the shape TS-09 proves the two measures disagree about.
 */
const DEPOSIT_HISTORY: readonly DailyValuationSnapshot[] = [
  snapshot('2026-01-01', '100000', '100000', '0'),
  snapshot('2026-07-01', '610000', '600000', '0'),
  snapshot('2027-01-01', '610000', '600000', '0'),
];

const POSITION = aPosition({
  assetId: assetIdOf('1'),
  quantity: Quantity.fromString('100'),
  value: money('12000'),
  costBasis: money('10000'),
});

function buildPort(snapshots: readonly DailyValuationSnapshot[]): FakeReportDataPort {
  return new FakeReportDataPort({
    positions: [POSITION],
    allocations: [],
    wallets: [{ walletId: walletIdOf('1'), name: 'Aposentadoria' }],
    institutions: [],
    assets: [anAsset({ assetId: assetIdOf('1') })],
    snapshots,
  });
}

const PERIOD: Period = { kind: 'custom', from: START, to: END };

async function run(options: {
  snapshots?: readonly DailyValuationSnapshot[];
  treatment?: EarningsTreatment;
  scope?: Scope;
  benchmarks?: readonly Benchmark[];
  index?: IndexSeriesReaderPort;
}): Promise<PerformanceReport> {
  const result = await runPerformanceReport(
    {
      port: buildPort(options.snapshots ?? DIVIDEND_HISTORY),
      indexSeries: options.index ?? new FakeIndexSeries({}),
    },
    {
      period: PERIOD,
      scope: options.scope ?? { kind: 'portfolio' },
      grouping: 'asset_class',
      today: END,
      treatment: options.treatment ?? EarningsTreatment.WITHOUT_EARNINGS,
      benchmarks: options.benchmarks ?? [],
      divergencePoints: DEFAULT_DIVERGENCE_POINTS,
      earliest: START,
    },
  );
  if (!result.ok) throw new Error(`expected a report, got ${result.error.code}`);
  return result.value;
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`expected a value, got ${result.error.code}`);
  return result.value;
}

function errorCode(result: { ok: true } | { ok: false; error: { code: string } }): string {
  if (result.ok) throw new Error('expected an unavailable result');
  return result.error.code;
}

describe('SPEC-012 BR-012-06..08 — with and without earnings (AC-7, AC-8)', () => {
  /**
   * The flows are the **differences** of the snapshot's cumulative totals, and
   * the first snapshot contributes none — its value already includes every
   * trade made on or before that date.
   */
  it('derives flows as differences and never counts the opening snapshot twice', () => {
    const series = seriesFromSnapshots(DIVIDEND_HISTORY, EarningsTreatment.WITHOUT_EARNINGS);
    expect(series.points.map((point) => point.value.toString())).toEqual([
      '100000',
      '110000',
      '109000',
    ]);
    // Contributions never changed after the opening balance, so every flow is
    // zero — the opening 100.000 is inside the first point, not a flow.
    expect(series.flows.map((flow) => flow.amount.toString())).toEqual(['0', '0']);
  });

  /**
   * **AC-7 — with earnings exceeds without earnings by exactly the earnings
   * received.**
   *
   * Hand-computed over the dividend fixture:
   *   without  gain = 109.000 − 100.000 − 0        = **9.000**
   *   with     gain = 109.000 − 100.000 − (−1.000) = **10.000**
   *   difference = 1.000 = the proventos paid in the period ✓
   */
  it('AC-7 — the gap between the two views is exactly the proventos received', () => {
    const without = seriesFromSnapshots(DIVIDEND_HISTORY, EarningsTreatment.WITHOUT_EARNINGS);
    const with_ = seriesFromSnapshots(DIVIDEND_HISTORY, EarningsTreatment.WITH_EARNINGS);

    expect(without.gain.toString()).toBe('9000');
    expect(with_.gain.toString()).toBe('10000');
    expect(with_.gain.minus(without.gain).toString()).toBe('1000');
    expect(with_.earningsInPeriod.toString()).toBe('1000');
  });

  /**
   * **AC-8 — earnings are not reinvested, and no synthetic purchase appears.**
   *
   * The dividend enters as money *leaving* the portfolio on pay date — a
   * negative external flow of 1.000. A reinvestment assumption would have shown
   * up here as a positive flow, inventing a buy the user never made (DL-012-03).
   */
  it('AC-8 — a dividend is money out on pay date, never a synthetic buy', () => {
    const with_ = seriesFromSnapshots(DIVIDEND_HISTORY, EarningsTreatment.WITH_EARNINGS);
    const payDate = with_.flows.find((flow) => flow.date === END);
    expect(payDate?.amount.toString()).toBe('-1000');
    expect(with_.flows.some((flow) => flow.amount.isPositive())).toBe(false);
  });

  /**
   * Hand-computed, without earnings:
   *   01/01 → 01/07 (a gap): gain 10.000 on base 100.000 = 0,10
   *   01/07 → 01/01 (a gap): gain −1.000 on base 110.000 = −0,009090909091
   *   TWR = 1,10 × 0,990909090909 − 1 = **0,09**
   *
   * which is also 109.000 ÷ 100.000 − 1, because there were no flows.
   *
   * With earnings the second sub-period's gain becomes
   *   109.000 − 110.000 − (−1.000) = 0 → r = 0
   *   TWR = 1,10 × 1 − 1 = **0,10**
   */
  it('BR-012-09 — both views run over the same scope and period', async () => {
    const without = await run({ treatment: EarningsTreatment.WITHOUT_EARNINGS });
    const with_ = await run({ treatment: EarningsTreatment.WITH_EARNINGS });

    expect(unwrap(without.twr).returnRate.toString()).toBe('0.09');
    expect(unwrap(with_.twr).returnRate.toString()).toBe('0.1');
  });

  /**
   * XIRR over the same fixture. The only flows are the opening balance and the
   * closing value, exactly one year apart:
   *   without: −100.000 + 109.000 ÷ (1+r) = 0 → r = **0,09**
   *   with:    the 1.000 dividend comes back on the same closing date, so the
   *            flows net to 110.000 → r = **0,10**
   */
  it('BR-012-03 — XIRR agrees with TWR when there are no interim flows', async () => {
    const without = await run({ treatment: EarningsTreatment.WITHOUT_EARNINGS });
    const with_ = await run({ treatment: EarningsTreatment.WITH_EARNINGS });

    expect(unwrap(without.xirr).rate.toString()).toBe('0.09');
    expect(unwrap(with_.xirr).rate.toString()).toBe('0.1');
    // No interim flow means nothing for the two measures to disagree about.
    expect(without.explainDivergence).toBe(false);
  });

  it('BR-012-03 — inverts the sign convention exactly once, on the way to XIRR', () => {
    const series = seriesFromSnapshots(DEPOSIT_HISTORY, EarningsTreatment.WITHOUT_EARNINGS);
    const flows = cashFlowsFrom(series);
    // Opening capital and the July deposit are money the user parted with;
    // the closing value is what they would get back.
    expect(flows.map((flow) => flow.amount.toString())).toEqual([
      '-100000',
      '-500000',
      '0',
      '610000',
    ]);
  });

  it('produces no cash flows at all from an empty series', () => {
    expect(cashFlowsFrom(seriesFromSnapshots([], EarningsTreatment.WITH_EARNINGS))).toEqual([]);
  });
});

describe('SPEC-012 BR-012-04 — the inline explanation of a material gap (AC-5)', () => {
  /**
   * The TS-09 shape, end to end through the report.
   *
   *   TWR = 1,10 × 1 − 1 = **0,10**   (the deposit day cancels exactly:
   *         610.000 − 100.000 − 500.000 = 10.000 on a base of 100.000)
   *
   * XIRR discounts three flows — −100.000 at t=0, −500.000 at t=181/365 and
   * +610.000 at t=1 — and is bracketed by hand from `f(r) = Σ CF (1+r)^(−t)`:
   *
   *   f(0,02) = −100.000 − 500.000 × 1,02^(−0,495890) + 610.000 ÷ 1,02
   *           = −100.000 − 495.114 + 598.039 = **+2.925**  → root is above 0,02
   *   f(0,03) = −100.000 − 500.000 × 1,03^(−0,495890) + 610.000 ÷ 1,03
   *           = −100.000 − 492.724 + 592.233 = **−491**    → root is below 0,03
   *
   * So the money-weighted return is around 2,9 % against a time-weighted 10 %:
   * seven points apart, and the report owes the user a sentence explaining why
   * half a million reais sitting idle for six months does that to one figure
   * and not the other.
   */
  it('flags a material TWR/XIRR divergence', async () => {
    const report = await run({ snapshots: DEPOSIT_HISTORY });

    expect(unwrap(report.twr).returnRate.toString()).toBe('0.1');
    const xirr = unwrap(report.xirr);
    expect(xirr.rate.toDecimal().greaterThan('0.02')).toBe(true);
    expect(xirr.rate.toDecimal().lessThan('0.03')).toBe(true);
    expect(report.explainDivergence).toBe(true);
  });

  it('does not offer an explanation when one of the two figures is unavailable', async () => {
    // Nothing to explain a gap between: there is no gap, there is a blank.
    const report = await run({ scope: { kind: 'wallet', walletId: walletIdOf('1') } });
    expect(report.explainDivergence).toBe(false);
  });
});

describe('SPEC-012 BR-012-02 — the Modified Dietz disclosure reaches the report', () => {
  it('names the sub-periods that used the fallback', async () => {
    const report = await run({});
    const twr = unwrap(report.twr);
    // The fixture holds three snapshots across a year, so both sub-periods are
    // gaps — and the UI is told which, rather than being handed a figure that
    // silently claims daily precision.
    expect(twr.dietzPeriods.map((disclosure) => disclosure.range)).toEqual([
      { from: '2026-01-01', to: '2026-07-01' },
      { from: '2026-07-01', to: '2027-01-01' },
    ]);
    expect(twr.dietzPeriods.map((disclosure) => disclosure.spanDays)).toEqual([181, 184]);
  });
});

describe('SPEC-012 AC-16 — wallet scope reports what it cannot compute', () => {
  /**
   * `daily_valuation_snapshots` is persisted at portfolio grain, so a wallet has
   * no daily series to link. Substituting the portfolio's would attach one
   * wallet's name to the whole *patrimônio*'s return — every figure real, and
   * every one of them answering a different question from the heading above it.
   */
  it('reports the time-weighted measures as unavailable rather than approximating them', async () => {
    const report = await run({ scope: { kind: 'wallet', walletId: walletIdOf('1') } });

    expect(errorCode(report.twr)).toBe('PERFORMANCE_SCOPE_SERIES_UNAVAILABLE');
    expect(errorCode(report.xirr)).toBe('PERFORMANCE_SCOPE_SERIES_UNAVAILABLE');
    expect(errorCode(report.percentOfCdi)).toBe('PERFORMANCE_SCOPE_SERIES_UNAVAILABLE');
    expect(errorCode(report.realReturn)).toBe('PERFORMANCE_SCOPE_SERIES_UNAVAILABLE');
  });

  it('refuses a scope naming a wallet this tenant does not have', async () => {
    const result = await runPerformanceReport(
      { port: buildPort(DIVIDEND_HISTORY), indexSeries: new FakeIndexSeries({}) },
      {
        period: PERIOD,
        scope: { kind: 'wallet', walletId: walletIdOf('9') },
        grouping: 'asset_class',
        today: END,
        treatment: EarningsTreatment.WITHOUT_EARNINGS,
        benchmarks: [],
        divergencePoints: DEFAULT_DIVERGENCE_POINTS,
        earliest: START,
      },
    );
    expect(errorCode(result)).toBe('REPORTING_WALLET_NOT_FOUND');
  });

  it('refuses a period whose range is invalid before computing anything', async () => {
    const result = await runPerformanceReport(
      { port: buildPort(DIVIDEND_HISTORY), indexSeries: new FakeIndexSeries({}) },
      {
        period: { kind: 'custom', from: END, to: START },
        scope: { kind: 'portfolio' },
        grouping: 'asset_class',
        today: END,
        treatment: EarningsTreatment.WITHOUT_EARNINGS,
        benchmarks: [],
        divergencePoints: DEFAULT_DIVERGENCE_POINTS,
        earliest: START,
      },
    );
    expect(errorCode(result)).toBe('REPORTING_INVALID_PERIOD_RANGE');
  });
});

describe('SPEC-012 BR-012-10..13 — benchmarks (AC-9, AC-10, AC-12)', () => {
  /**
   * A CDI series with a single published day at 0,05 % accumulates to 1,0005
   * over the period, so the benchmark returned 0,0005.
   *
   *   "% do CDI" = 0,09 ÷ 0,0005 × 100 = 180 × 100 = **18.000 %**
   *
   * An extreme number because the fixture publishes one CDI day in a year, but
   * an exact one — which is what a hand-computed expectation is for.
   */
  const index = new FakeIndexSeries({
    CDI: [{ date: START, value: Quantity.fromString('0.05') }],
    IPCA: [{ date: START, value: Quantity.fromString('0.42') }],
    IBOV: [
      { date: day('2025-12-31'), value: Quantity.fromString('100000') },
      { date: END, value: Quantity.fromString('110000') },
    ],
  });

  it('AC-9 — each benchmark is computed independently of the others', async () => {
    const cdiOnly = await run({ benchmarks: ['CDI'], index });
    expect(cdiOnly.benchmarks.map((outcome) => outcome.benchmark)).toEqual(['CDI']);
    // Not selected is not the same as unavailable — but neither one produces a
    // figure, and both say so.
    expect(errorCode(cdiOnly.realReturn)).toBe('PERFORMANCE_BENCHMARK_SERIES_EMPTY');

    const all = await run({ benchmarks: ['CDI', 'IPCA', 'IBOV'], index });
    expect(all.benchmarks.map((outcome) => outcome.benchmark)).toEqual(['CDI', 'IPCA', 'IBOV']);
    expect(unwrap(all.benchmarks[2]!.line).returnRate.toString()).toBe('0.1');
  });

  it('AC-10 — "% do CDI" against the hand-computed accumulation', async () => {
    const report = await run({ benchmarks: ['CDI'], index });
    expect(unwrap(report.benchmarks[0]!.line).returnRate.toString()).toBe('0.0005');
    expect(unwrap(report.percentOfCdi).toString()).toBe('18000');
  });

  /**
   * AC-12 — the real return.
   *
   * January's 0,42 % is the only IPCA in the fixture, so the deflator is 1,0042
   * and the real return is 1,09 ÷ 1,0042 − 1. Bracketed by hand:
   *   1,0042 × 1,0854 = 1,08995868 < 1,09  → the real return is above 0,0854
   *   1,0042 × 1,0855 = 1,09005910 > 1,09  → and below 0,0855
   */
  it('AC-12 — the IPCA-adjusted return, hand-bracketed', async () => {
    const report = await run({ benchmarks: ['IPCA'], index });
    expect(unwrap(report.benchmarks[0]!.line).returnRate.toString()).toBe('0.0042');

    const real = unwrap(report.realReturn);
    expect(real.toDecimal().greaterThan('0.0854')).toBe(true);
    expect(real.toDecimal().lessThan('0.0855')).toBe(true);
  });

  /**
   * AC-11 — the shadow portfolio applies the user's real dates and amounts.
   *
   * Over the deposit fixture, at a CDI that accrues 0,05 % on 1 January only:
   *   01/01/2026  100.000                          (opening value)
   *   02/01/2026  100.000 × 1,0005 = 100.050       (the only CDI day)
   *   01/07/2026  100.050 + 500.000 = 600.050      (the user's real deposit)
   *   01/01/2027  600.050                          (nothing further accrues)
   */
  it('AC-11 — the shadow portfolio replays the user’s own flows', async () => {
    const report = await run({
      snapshots: DEPOSIT_HISTORY,
      benchmarks: ['CDI'],
      index,
    });
    const shadow = report.benchmarks[0]?.shadow;
    expect(shadow?.finalValue.toString()).toBe('600050');
    // The deposit lands on the user's date, not on the period's edges.
    const july = shadow?.points.find((point) => point.date === MIDDLE);
    expect(july?.value.toString()).toBe('600050');
  });

  it('carries no shadow where the benchmark line itself is unavailable', async () => {
    const report = await run({ benchmarks: ['IBOV'], index: new FakeIndexSeries({}) });
    expect(errorCode(report.benchmarks[0]!.line)).toBe('PERFORMANCE_BENCHMARK_SERIES_EMPTY');
    expect(report.benchmarks[0]?.shadow).toBeNull();
    expect(errorCode(report.percentOfCdi)).toBe('PERFORMANCE_BENCHMARK_SERIES_EMPTY');
  });

  it('propagates a selected benchmark’s own failure into the comparison', async () => {
    // CDI *is* selected here, and its series is the thing that is missing — a
    // different situation from "the user did not ask for CDI", and one the
    // comparison must not paper over with a zero benchmark.
    const report = await run({ benchmarks: ['CDI'], index: new FakeIndexSeries({ CDI: [] }) });
    expect(errorCode(report.benchmarks[0]!.line)).toBe('PERFORMANCE_BENCHMARK_SERIES_EMPTY');
    expect(errorCode(report.percentOfCdi)).toBe('PERFORMANCE_BENCHMARK_SERIES_EMPTY');
  });

  it('replays a shadow from a zero opening value when the scope has no series', async () => {
    // The benchmark still has a line — the index exists whether or not this
    // tenant does — so the shadow is drawn from nothing rather than skipped.
    const result = await runPerformanceReport(
      {
        port: new FakeReportDataPort({
          positions: [],
          allocations: [],
          wallets: [],
          institutions: [],
          assets: [],
          snapshots: [],
        }),
        indexSeries: index,
      },
      {
        period: PERIOD,
        scope: { kind: 'portfolio' },
        grouping: 'asset_class',
        today: END,
        treatment: EarningsTreatment.WITHOUT_EARNINGS,
        benchmarks: ['CDI'],
        divergencePoints: DEFAULT_DIVERGENCE_POINTS,
        earliest: START,
      },
    );
    if (!result.ok) throw new Error('expected a report');

    expect(unwrap(result.value.benchmarks[0]!.line).returnRate.toString()).toBe('0.0005');
    expect(result.value.benchmarks[0]?.shadow?.finalValue.toString()).toBe('0');
  });
});

describe('SPEC-012 BR-012-15/16 — contribution reaches the report (AC-13)', () => {
  /**
   * One stock position: cost basis 10.000, valued 12.000.
   *   gain = 2.000, base = 10.000 → own return and total return both **0,20**
   *   and the single group's contribution is the whole of it.
   */
  it('decomposes the scope on cost basis and reconciles to the total', async () => {
    const report = await run({});
    const contribution = unwrap(report.contribution);

    expect(contribution.totalReturn.toString()).toBe('0.2');
    expect(contribution.groups).toHaveLength(1);
    expect(contribution.groups[0]?.key.id).toBe('stock');
    expect(contribution.groups[0]?.ownReturn?.toString()).toBe('0.2');
    expect(contribution.groups[0]?.contribution.toString()).toBe('0.2');
  });
});

describe('SPEC-012 BR-012-18 — an empty period (AC-15)', () => {
  it('renders the empty state rather than a zero or an infinite return', async () => {
    const result = await runPerformanceReport(
      {
        port: new FakeReportDataPort({
          positions: [],
          allocations: [],
          wallets: [],
          institutions: [],
          assets: [],
          snapshots: [],
        }),
        indexSeries: new FakeIndexSeries({}),
      },
      {
        period: PERIOD,
        scope: { kind: 'portfolio' },
        grouping: 'asset_class',
        today: END,
        treatment: EarningsTreatment.WITHOUT_EARNINGS,
        benchmarks: [],
        divergencePoints: DEFAULT_DIVERGENCE_POINTS,
        earliest: START,
      },
    );
    if (!result.ok) throw new Error('expected an empty report, not a failure');

    expect(result.value.empty).toBe(true);
    expect(errorCode(result.value.twr)).toBe('PERFORMANCE_NO_SERIES');
    expect(errorCode(result.value.xirr)).toBe('PERFORMANCE_XIRR_INSUFFICIENT_FLOWS');
    expect(errorCode(result.value.contribution)).toBe('PERFORMANCE_NO_CAPITAL_BASE');
  });
});
