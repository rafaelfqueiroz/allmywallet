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
  type PerformanceSeries,
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

/**
 * `PerformanceReport.series` is nullable because a **wallet** scope has no
 * series behind it — `daily_valuation_snapshots` is persisted at portfolio
 * grain. Every assertion in this file that reaches into the series is a
 * portfolio-scope one, so this narrows and fails loudly rather than letting a
 * `?.` quietly turn a missing series into a passing expectation.
 */
function portfolioSeries(report: { series: PerformanceSeries | null }): PerformanceSeries {
  if (report.series === null) throw new Error('expected a portfolio-scope series');
  return report.series;
}

/**
 * A period whose start is **not** the tenant's first snapshot, so
 * `findSnapshotBefore` has a baseline to return. Everything below shares this
 * runner; `run` above deliberately does not, because its fixture starts on the
 * period's own first date and must keep exercising the no-baseline path.
 */
async function runRange(options: {
  snapshots: readonly DailyValuationSnapshot[];
  from: string;
  to: string;
  benchmarks?: readonly Benchmark[];
  index?: IndexSeriesReaderPort;
  port?: FakeReportDataPort;
}): Promise<PerformanceReport> {
  const result = await runPerformanceReport(
    {
      port: options.port ?? buildPort(options.snapshots),
      indexSeries: options.index ?? new FakeIndexSeries({}),
    },
    {
      period: { kind: 'custom', from: day(options.from), to: day(options.to) },
      scope: { kind: 'portfolio' },
      grouping: 'asset_class',
      today: day(options.to),
      treatment: EarningsTreatment.WITHOUT_EARNINGS,
      benchmarks: options.benchmarks ?? [],
      divergencePoints: DEFAULT_DIVERGENCE_POINTS,
      earliest: day('2026-02-27'),
    },
  );
  if (!result.ok) throw new Error(`expected a report, got ${result.error.code}`);
  return result.value;
}

const MARCH = Array.from(
  { length: 31 },
  (_, index) => `2026-03-${String(index + 1).padStart(2, '0')}`,
);

/**
 * **The defect this suite exists for.** A portfolio worth R$ 100.000,00 at
 * February's close gains 5 % on 1 March and does nothing for the rest of the
 * month. There are no contributions at all, so every flow is zero and the whole
 * return is price movement on one day.
 *
 * **Two snapshots sit before the period, deliberately.** The baseline is the
 * *latest* one that precedes it, and a fixture with only one cannot tell a
 * correct lookup from one that takes whichever row it happens to see first —
 * the same reason `tests/integration/portfolio-value-reads.test.ts` seeds three
 * rows to prove `ORDER BY date DESC LIMIT 1`. Taking 27/02's 90.000 instead
 * would make the period open below where it really did and report 16,67 %.
 */
const FIRST_DAY_HISTORY: readonly DailyValuationSnapshot[] = [
  snapshot('2026-02-27', '90000', '100000', '0'),
  snapshot('2026-02-28', '100000', '100000', '0'),
  ...MARCH.map((date) => snapshot(date, '105000', '100000', '0')),
];

describe('SPEC-012 BR-012-01/03 — the period opens on the close before it, not on its own first close', () => {
  /**
   * **AC-1 / TS-12 — the first day of the period belongs to the period.**
   *
   * A `daily_valuation_snapshots` row dated `d` is the **close** of `d`
   * (SPEC-009 replays to and including the date), so the row dated 01/03 already
   * holds the 5 % that day produced. Opening the series on it measures from the
   * end of the first day and reports the month as flat.
   *
   * Hand-computed over the fixture, opening on **28/02**:
   *
   *   28/02 → 01/03   F = 100.000 − 100.000 = 0
   *                   gain = 105.000 − 100.000 − 0 = 5.000
   *                   base = 100.000            r = 5.000 ÷ 100.000 = **0,05**
   *   01/03 → 02/03 … 30/03 → 31/03   (30 sub-periods)
   *                   gain = 105.000 − 105.000 − 0 = 0
   *                   base = 105.000            r = **0**
   *
   *   TWR = 1,05 × 1^30 − 1 = **0,05**
   *
   * And that is the same 5 % *Patrimônio* reports for the identical range —
   * (105.000 − 100.000) ÷ 100.000 — which is the cross-report invariant that was
   * broken: one screen said +5 % growth while the other said 0,00 % return.
   */
  it('AC-1 — a first-day gain is inside the return, and matches Patrimônio for the same range', async () => {
    const report = await runRange({
      snapshots: FIRST_DAY_HISTORY,
      from: '2026-03-01',
      to: '2026-03-31',
    });

    expect(portfolioSeries(report).points[0]?.date).toBe('2026-02-28');
    expect(portfolioSeries(report).points[0]?.value.toString()).toBe('100000');
    // 31 March closes plus the February baseline in front of them.
    expect(portfolioSeries(report).points).toHaveLength(32);
    expect(unwrap(report.twr).returnRate.toString()).toBe('0.05');

    // The reported range is still the range the user asked for. Only the
    // measurement's starting point moved.
    expect(report.range).toEqual({ from: '2026-03-01', to: '2026-03-31' });
  });

  /**
   * **BR-012-03 — XIRR consumes the same series, so it needed the same
   * correction and receives it here.**
   *
   * `cashFlowsFrom` takes the series' first point as the capital already
   * committed. Before the baseline existed that was 105.000 on 01/03 against
   * 105.000 on 31/03, netting to a root of exactly **zero** — the same lie TWR
   * was telling, in the other measure.
   *
   * With the baseline the flows are −100.000 on 28/02 and +105.000 on 31/03,
   * 31 calendar days apart. Bracketed by hand from
   * `f(r) = −100.000 + 105.000 × (1+r)^(−31/365)`:
   *
   *   f(0,77) = −100.000 + 105.000 ÷ 1,77^0,0849315
   *           = −100.000 + 105.000 ÷ 1,0496878 = +29,74  → root is above 0,77
   *   f(0,78) = −100.000 + 105.000 ÷ 1,78^0,0849315
   *           = −100.000 + 105.000 ÷ 1,0501902 = −18,10  → root is below 0,78
   *
   * Five per cent in a month annualises to about 77,6 %, which is exactly what
   * a money-weighted return is supposed to say about it.
   */
  it('BR-012-03 — XIRR measures from the same opening capital, and is no longer zero', async () => {
    const report = await runRange({
      snapshots: FIRST_DAY_HISTORY,
      from: '2026-03-01',
      to: '2026-03-31',
    });

    const xirr = unwrap(report.xirr);
    expect(xirr.rate.toDecimal().greaterThan('0.77')).toBe(true);
    expect(xirr.rate.toDecimal().lessThan('0.78')).toBe(true);
  });

  /**
   * **Cash-flow alignment — the failure mode in the opposite direction.**
   *
   * Moving the opening back one close without moving the flows with it would
   * credit a contribution made on `from` to the portfolio as *performance*. The
   * flows are differences of the cumulative `net_contributions`, so prepending
   * the baseline produces the contribution as one flow dated 01/03, inside the
   * one sub-period that ends there.
   *
   *   28/02  value 100.000  contribuições 100.000
   *   01/03  value 155.000  contribuições 150.000   ← R$ 50.000,00 deposited
   *   02/03  value 155.000  contribuições 150.000
   *
   *   28/02 → 01/03   F    = 150.000 − 100.000 = 50.000
   *                   gain = 155.000 − 100.000 − 50.000 = 5.000
   *                   base = 100.000 (w = 0, the opening value)
   *                   r    = 5.000 ÷ 100.000 = **0,05**
   *   01/03 → 02/03   gain = 0 → r = **0**
   *
   *   TWR = 1,05 − 1 = **0,05**
   *
   * Drop that flow and the same numbers read 55.000 ÷ 100.000 = **0,55** — a
   * deposit rendered as an eleven-fold overstatement of the return. Count it
   * twice and the numerator turns negative. Neither happens.
   */
  it('attributes a contribution dated `from` to the sub-period ending at `from`', async () => {
    const report = await runRange({
      snapshots: [
        snapshot('2026-02-28', '100000', '100000', '0'),
        snapshot('2026-03-01', '155000', '150000', '0'),
        snapshot('2026-03-02', '155000', '150000', '0'),
      ],
      from: '2026-03-01',
      to: '2026-03-02',
    });

    // Exactly one flow, on the user's own date, at its own size.
    expect(
      portfolioSeries(report).flows.map((flow) => [flow.date, flow.amount.toString()]),
    ).toEqual([
      ['2026-03-01', '50000'],
      ['2026-03-02', '0'],
    ]);
    expect(unwrap(report.twr).returnRate.toString()).toBe('0.05');
    // `gain` is the money the period actually made — the deposit is not it.
    expect(portfolioSeries(report).gain.toString()).toBe('5000');
  });

  /**
   * **BR-012-02 — Modified Dietz needed no correction of its own.**
   *
   * Its interval is already half-open, `(from, to]`, for exactly the reason the
   * baseline exists: a flow dated `from` is inside `V_begin` when `from` is a
   * close. Making the baseline the sub-period's start therefore hands the same
   * flow to the same interval, and the fallback picks it up unchanged.
   *
   * Baseline on **27/02** rather than 28/02, so the first sub-period spans a
   * gap and takes the fallback:
   *
   *   D    = 01/03 − 27/02 = 2 calendar days
   *   d    = 01/03 − 27/02 = 2          w = (2 − 2) ÷ 2 = 0
   *   num  = 155.000 − 100.000 − 50.000 = 5.000
   *   den  = 100.000 + 50.000 × 0       = 100.000
   *   R    = 5.000 ÷ 100.000            = **0,05**
   *
   *   01/03 → 02/03 is a single day and links at r = 0, so TWR = **0,05**.
   */
  it('BR-012-02 — the fallback spans the baseline gap and still sees the flow', async () => {
    const report = await runRange({
      snapshots: [
        snapshot('2026-02-27', '100000', '100000', '0'),
        snapshot('2026-03-01', '155000', '150000', '0'),
        snapshot('2026-03-02', '155000', '150000', '0'),
      ],
      from: '2026-03-01',
      to: '2026-03-02',
    });

    const twr = unwrap(report.twr);
    expect(twr.returnRate.toString()).toBe('0.05');
    expect(twr.dietzPeriods).toEqual([
      { range: { from: '2026-02-27', to: '2026-03-01' }, spanDays: 2 },
    ]);
  });

  /**
   * **The no-baseline case is unchanged, and must be.**
   *
   * A period starting at or before the tenant's very first snapshot has nothing
   * before it. `findSnapshotBefore` returns null there — asserted against real
   * Postgres in `tests/integration/portfolio-value-reads.test.ts` — and the
   * series legitimately opens on the portfolio's first recorded value. Inventing
   * a zero baseline instead would report the whole opening *patrimônio* as a
   * first-day gain.
   */
  it('opens on the first in-range snapshot when there is nothing before it', async () => {
    const port = buildPort(DIVIDEND_HISTORY);
    const report = await runRange({
      snapshots: DIVIDEND_HISTORY,
      port,
      from: '2026-01-01',
      to: '2027-01-01',
    });

    // Portfolio scope, so there is a series — `null` is the wallet-scope case.
    const series = portfolioSeries(report);
    expect(series.points[0]?.date).toBe('2026-01-01');
    expect(series.points).toHaveLength(3);
    // Unchanged from before the baseline existed: 1,10 × 0,990909090909 − 1.
    expect(unwrap(report.twr).returnRate.toString()).toBe('0.09');

    // BR-011-13 / TS-32: the baseline is a snapshot read, like every other
    // figure on this page. Nothing here reaches the ledger.
    expect(port.calls).toContain('findSnapshotBefore:2026-01-01');
  });

  /**
   * **A baseline alone is not a series.**
   *
   * A range with no snapshot inside it has nothing to measure *to*. Linking the
   * lone prior point would produce an empty product and publish a confident
   * 0 % — the misleading zero BR-012-18 exists to forbid, and the one a user
   * has no way to detect.
   */
  it('BR-012-18 — a period with a baseline but no observations is unavailable, not flat', async () => {
    const report = await runRange({
      snapshots: [snapshot('2026-02-28', '100000', '100000', '0')],
      from: '2026-03-01',
      to: '2026-03-02',
    });

    expect(errorCode(report.twr)).toBe('PERFORMANCE_NO_SERIES');
    expect(portfolioSeries(report).points).toHaveLength(0);
  });

  /**
   * **BR-012-11/12/13 — the benchmark window follows the series window.**
   *
   * `accumulateRateSeries` pins its line to 1 on its own `from` and compounds
   * `[from, to)`, so its return is the growth of capital present from that
   * date's open — the close of the day before. Leave it on 01/03 while the
   * portfolio measures from 28/02 and "% do CDI" divides a two-day portfolio
   * return by a one-day CDI one, with nothing on screen to say so.
   *
   * CDI publishes 0,05 % on 28/02 and 0,10 % on 01/03. Accumulated from 28/02:
   *
   *   28/02  factor = 1                        (recorded before the day's rate)
   *   01/03  factor = 1,0005
   *   02/03  factor = 1,0005 × 1,001
   *                 = 1,0005 + 0,0010005 = **1,0015005**
   *   CDI return = **0,0015005**   (0,001 if the line still began on 01/03)
   *
   * The portfolio: 100.000 → 105.000 on 01/03, flat on 02/03 → TWR **0,05**.
   *
   *   % do CDI = 0,05 ÷ 0,0015005 × 100
   *            = 5.000.000 ÷ 1.500,5
   *            = 10.000.000 ÷ 3.001
   *            = 3.332 + 668/3.001
   *            = 3.332,2225924691769…  → **3.332,222592469177** at RATE_SCALE
   *
   * And the shadow, which starts from the same baseline value:
   *
   *   28/02  100.000,00                        (the opening close, no growth yet)
   *   01/03  100.000 × 1,0005          = 100.050,00
   *   02/03  100.050 × 1,001           = **100.150,05**
   */
  it('AC-10/AC-11 — the benchmark line and its shadow rebase off the baseline', async () => {
    const report = await runRange({
      snapshots: [
        snapshot('2026-02-28', '100000', '100000', '0'),
        snapshot('2026-03-01', '105000', '100000', '0'),
        snapshot('2026-03-02', '105000', '100000', '0'),
      ],
      from: '2026-03-01',
      to: '2026-03-02',
      benchmarks: ['CDI'],
      index: new FakeIndexSeries({
        CDI: [
          { date: day('2026-02-28'), value: Quantity.fromString('0.05') },
          { date: day('2026-03-01'), value: Quantity.fromString('0.10') },
        ],
      }),
    });

    const line = unwrap(report.benchmarks[0]!.line);
    expect(line.points[0]?.date).toBe('2026-02-28');
    expect(line.points[0]?.factor.toString()).toBe('1');
    expect(line.points.map((point) => point.factor.toString())).toEqual([
      '1',
      '1.0005',
      '1.0015005',
    ]);
    expect(line.returnRate.toString()).toBe('0.0015005');

    expect(unwrap(report.twr).returnRate.toString()).toBe('0.05');
    expect(unwrap(report.percentOfCdi).toString()).toBe('3332.222592469177');
    expect(report.benchmarks[0]?.shadow?.finalValue.toString()).toBe('100150.05');
  });
});

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

  /**
   * **BR-012-12 — the shadow portfolio is the user's own flows at the index's
   * rate, so at wallet scope there are none to replay.**
   *
   * The refusal above was originally written for TWR and XIRR alone, while
   * `loadBenchmarks` kept receiving the portfolio's series regardless. Over the
   * deposit fixture — 100.000 opening, a 500.000 deposit on 1 July, CDI
   * accruing 0,05 % on 1 January only — the shadow computed, by hand:
   *
   *   01/01/2026  100.000                       (the *portfolio's* opening)
   *   02/01/2026  100.000 × 1,0005 = 100.050
   *   01/07/2026  100.050 + 500.000 = 600.050   (the *portfolio's* deposit)
   *   01/01/2027  600.050
   *
   * and R$ 600.050 was published on the screen of a wallet holding R$ 12.000,
   * under "seus aportes nesse índice". Every figure in it real; none of it this
   * carteira's.
   *
   * The **line** is a different matter and is still computed: 0,0005 is what
   * CDI did over the period, a fact about the index rather than about this
   * tenant, and it is as true on a wallet's screen as on the portfolio's.
   */
  it('replays no shadow portfolio from the portfolio’s flows', async () => {
    const index = new FakeIndexSeries({
      CDI: [{ date: START, value: Quantity.fromString('0.05') }],
    });

    const portfolio = await run({ snapshots: DEPOSIT_HISTORY, benchmarks: ['CDI'], index });
    expect(portfolio.benchmarks[0]?.shadow?.finalValue.toString()).toBe('600050');

    const scoped = await run({
      snapshots: DEPOSIT_HISTORY,
      benchmarks: ['CDI'],
      index,
      scope: { kind: 'wallet', walletId: walletIdOf('1') },
    });
    expect(scoped.benchmarks[0]?.shadow).toBeNull();
    // The index's own return survives — it says nothing about this tenant.
    expect(unwrap(scoped.benchmarks[0]!.line).returnRate.toString()).toBe('0.0005');
  });

  /**
   * The series itself is portfolio grain, so it is withheld rather than handed
   * out under a wallet's name — otherwise the next caller repeats the defect
   * with a fresh chart instead of a fresh shadow.
   */
  it('withholds the portfolio-grain value series', async () => {
    const scoped = await run({ scope: { kind: 'wallet', walletId: walletIdOf('1') } });
    expect(scoped.series).toBeNull();

    const portfolio = await run({});
    expect(portfolio.series?.points).toHaveLength(3);
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
