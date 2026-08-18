import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import type { AssetClass } from '@/core/quotes/ports';
import type { DailyValuationSnapshot } from '@/core/valuation/ports';
import type { ReportQueryResult } from '@/core/reporting/base-query';
import type { GroupedReport, Scope } from '@/core/reporting/ports';
import { walletIdOf } from '@/core/reporting/test-support';
import {
  HistoryUnavailable,
  type MonthlyContribution,
  type SnapshotDerived,
  type ValuePoint,
} from './ports';
import { buildPortfolioValueReport } from './report';

/**
 * SPEC-013 — the assembled report.
 *
 * The assertion that matters most here is BR-013-12/DL-013-06: **the chart's
 * endpoint and the headline are the Composition report's total**, because they
 * are the same valued holdings rather than a second derivation. Two reports
 * disagreeing about how much money someone has is the worst defect this
 * product could ship, so the fixtures below give the last snapshot a
 * deliberately *different* figure — a regression that read the snapshot would
 * fail rather than coincidentally agree.
 *
 * The second half of the file is the same principle at wallet scope, where the
 * two figures come from tables with different grain and combining them
 * produced a number that was arithmetically perfect and completely false.
 */

const d = (value: string): BusinessDate => BusinessDate.of(value);
const m = (value: string): Money => Money.fromString(value);
const to8 = (value: Money): string => value.toDecimal().toFixed(8);

const WALLET = walletIdOf('1');
const PORTFOLIO_SCOPE: Scope = { kind: 'portfolio' };
const WALLET_SCOPE: Scope = { kind: 'wallet', walletId: WALLET };

function snapshot(
  date: string,
  totalValue: string,
  netContributions = '0',
  earningsToDate = '0',
  byAssetClass: ReadonlyMap<AssetClass, Money> = new Map(),
): DailyValuationSnapshot {
  return {
    date: d(date),
    totalValue: m(totalValue),
    netContributions: m(netContributions),
    earningsToDate: m(earningsToDate),
    byAssetClass,
    hasEstimates: false,
  };
}

/** Only the fields SPEC-013 folds over — the grouping itself is SPEC-011's. */
function groupedReport(total: string, estimated = false): GroupedReport {
  return {
    grouping: 'asset_class',
    groups: [],
    total: {
      value: m(total),
      costBasis: Money.zero(),
      quantity: Quantity.zero(),
      estimated,
    },
  };
}

function query(
  snapshots: readonly DailyValuationSnapshot[],
  holdingsTotal: string,
  options: {
    from?: string;
    to?: string;
    asOf?: string;
    estimated?: boolean;
    scope?: Scope;
  } = {},
): ReportQueryResult {
  const from = d(options.from ?? '2026-03-01');
  const to = d(options.to ?? '2026-03-31');
  const scope = options.scope ?? PORTFOLIO_SCOPE;
  return {
    range: { from, to },
    asOf: d(options.asOf ?? '2026-03-31'),
    scope: {
      scope,
      wallet: scope.kind === 'wallet' ? { walletId: scope.walletId, name: 'Reserva' } : null,
    },
    report: groupedReport(holdingsTotal, options.estimated ?? false),
    // Portfolio Value never renders a group name; the fixture only has to
    // satisfy the type.
    groupNames: new Map(),
    snapshots,
    empty: snapshots.length === 0,
  };
}

/** Narrows a `SnapshotDerived`, failing loudly rather than silently skipping. */
function present<T>(figure: SnapshotDerived<T>): T {
  if (figure.kind !== 'available') {
    throw new Error(`expected an available figure, got ${figure.reason}`);
  }
  return figure.value;
}

function absent<T>(figure: SnapshotDerived<T>): HistoryUnavailable {
  if (figure.kind !== 'unavailable') throw new Error('expected an unavailable figure');
  return figure.reason;
}

describe('buildPortfolioValueReport', () => {
  const today = d('2026-03-31');

  /**
   * BR-013-12 / DL-013-06. The last snapshot says 149.000; the valued
   * holdings say 150.000. The headline and the endpoint must both be 150.000
   * — the figure Composition totals.
   */
  it('headlines and ends on the holdings total, not the last snapshot', () => {
    const result = buildPortfolioValueReport({
      query: query([snapshot('2026-03-30', '148000'), snapshot('2026-03-31', '149000')], '150000'),
      opening: null,
      grouping: 'asset_class',
      today,
      lastImportAt: null,
    });

    expect(to8(result.headline.currentValue)).toBe('150000.00000000');
    expect(to8(present(result.series).at(-1)!.value)).toBe('150000.00000000');
  });

  it('decomposes against the snapshot preceding the range', () => {
    // opening 100.000 / contributed 100.000 → closing 130.000 / contributed 110.000
    //   contributions = 10.000; growth = 30.000; price change = 20.000
    const result = buildPortfolioValueReport({
      query: query([snapshot('2026-03-31', '130000', '110000')], '130000'),
      opening: snapshot('2026-02-28', '100000', '100000'),
      grouping: 'asset_class',
      today,
      lastImportAt: null,
    });

    const decomposition = present(result.decomposition);
    expect(to8(decomposition.netContributions)).toBe('10000.00000000');
    expect(to8(decomposition.priceChange)).toBe('20000.00000000');
  });

  it('picks granularity from the range, not the snapshot count', () => {
    const long = buildPortfolioValueReport({
      query: query([snapshot('2026-03-31', '100')], '100', {
        from: '2020-01-01',
        to: '2026-03-31',
      }),
      opening: null,
      grouping: 'asset_class',
      today,
      lastImportAt: null,
    });
    expect(long.granularity).toBe('monthly');
  });

  it('carries both freshness dates (BR-013-13)', () => {
    const result = buildPortfolioValueReport({
      query: query([snapshot('2026-03-31', '100')], '100'),
      opening: null,
      grouping: 'asset_class',
      today,
      lastImportAt: d('2026-03-15'),
    });

    expect(result.freshness.valuationAsOf).toBe('2026-03-31');
    expect(result.freshness.lastImportAt).toBe('2026-03-15');
  });

  it('reports no import date rather than inventing one', () => {
    const result = buildPortfolioValueReport({
      query: query([snapshot('2026-03-31', '100')], '100'),
      opening: null,
      grouping: 'asset_class',
      today,
      lastImportAt: null,
    });
    expect(result.freshness.lastImportAt).toBe(null);
  });

  it('passes the grouping through to the stacked series', () => {
    const result = buildPortfolioValueReport({
      query: query([snapshot('2026-03-31', '100')], '100'),
      opening: null,
      grouping: 'wallet',
      today,
      lastImportAt: null,
    });
    expect(result.stacked.kind).toBe('unavailable');
    if (result.stacked.kind !== 'unavailable') return;
    // At **portfolio** scope, grouping by wallet fails for the dimension's own
    // reason — the snapshot decomposes by asset class and nothing else. The
    // scope-level refusal below is a different absence with a different cause.
    expect(result.stacked.reason).toBe(HistoryUnavailable.NO_HISTORICAL_BREAKDOWN);
  });

  /**
   * BR-011-16 — an empty scope renders an explanatory state, and every figure
   * it carries must be a genuine zero rather than a crash or a NaN.
   */
  it('produces zeros, not failures, for a scope with no snapshots', () => {
    const result = buildPortfolioValueReport({
      query: query([], '0'),
      opening: null,
      grouping: 'asset_class',
      today,
      lastImportAt: null,
    });

    expect(to8(present(result.decomposition).closing)).toBe('0.00000000');
    expect(present(result.monthlyContributions)).toEqual([]);
    expect(present(result.headline.invested).gainRatio).toBe(null);
    // The live endpoint still applies: asOf is today, so the series is the
    // single live point rather than nothing at all.
    expect(present(result.series)).toHaveLength(1);
  });

  it('carries the live estimate flag onto the endpoint', () => {
    const result = buildPortfolioValueReport({
      query: query([snapshot('2026-03-31', '100')], '100', { estimated: true }),
      opening: null,
      grouping: 'asset_class',
      today,
      lastImportAt: null,
    });
    expect(present(result.series).at(-1)!.estimated).toBe(true);
  });
});

/**
 * SPEC-011 BR-011-02 / SPEC-013 BR-013-11 — **wallet scope reports what the
 * snapshot table cannot answer, and shows what it can.**
 *
 * ## The report this replaces
 *
 * `daily_valuation_snapshots` has one row per user per day and no wallet
 * column (ADR-002). Before this refusal, a wallet-scoped Patrimônio combined
 * the *scoped* holding total with the *portfolio's* snapshot series. The
 * fixture below is the reported case, and the arithmetic it used to produce is
 * worth writing out because every input in it is a real number about this user:
 *
 *   portfolio, every day of March:  total_value 400.000, net_contributions 400.000
 *   wallet "Reserva", valued today:                      holdings      10.000
 *
 *   totalInvested = closing.netContributions       = 400.000
 *   absoluteGain  = 10.000 − 400.000               = −390.000
 *   gainRatio     = −390.000 ÷ 400.000             = −0,975   →  **−97,5 %**
 *
 *   series        = [30/03 = 400.000, 31/03 = 10.000]
 *                   ← the portfolio's line for the whole period, then
 *                     `withLiveEndpoint` splices the wallet's value onto the
 *                     end and the chart falls off a cliff on the last point
 *   decomposition = opening 400.000 → closing 400.000, i.e. the portfolio's
 *   stacked       = the portfolio's bands, under a wallet's heading
 *
 * Nothing on that screen looks broken. A user who has never withdrawn anything
 * is told they have lost 97,5 % of a carteira, and the only way to discover it
 * is to reconcile against a broker statement.
 *
 * ## Why the answer is a refusal rather than a better estimate
 *
 * There is no wallet-grain history to compute from and none can be
 * synthesised: `wallet_allocations` stores only its *current* state, so
 * applying today's split to past days would rewrite every historical chart on
 * the next reassignment, and a rebuild would then disagree with the snapshot it
 * replaced (DM-4). ADR-002 records the decision; effective-dated allocation
 * history is backlog issue #50.
 */
describe('SPEC-013 at wallet scope — snapshot-derived figures are unavailable', () => {
  const today = d('2026-03-31');

  /** The reported portfolio: 400.000, entirely contributed, flat across March. */
  const PORTFOLIO_HISTORY = [
    snapshot('2026-03-30', '400000', '400000'),
    snapshot('2026-03-31', '400000', '400000'),
  ];

  const OPENING = snapshot('2026-02-28', '400000', '400000');

  function run(scope: Scope, grouping: 'asset_class' | 'wallet' = 'asset_class') {
    return buildPortfolioValueReport({
      // The wallet holds R$ 10.000 of the R$ 400.000 portfolio.
      query: query(PORTFOLIO_HISTORY, '10000', { scope }),
      opening: OPENING,
      grouping,
      today,
      lastImportAt: d('2026-03-15'),
    });
  }

  it('never produces the −97,5 % gain ratio', () => {
    const result = run(WALLET_SCOPE);
    expect(result.headline.invested.kind).toBe('unavailable');
    // Belt and braces: whatever else changes, this number must not come back.
    expect(JSON.stringify(result.headline.invested)).not.toContain('0.975');
  });

  it('refuses the headline’s invested figures, naming the cause', () => {
    expect(absent(run(WALLET_SCOPE).headline.invested)).toBe(
      HistoryUnavailable.WALLET_SCOPE_NOT_SNAPSHOTTED,
    );
  });

  it('refuses the value series rather than drawing the portfolio’s line', () => {
    expect(absent(run(WALLET_SCOPE).series)).toBe(HistoryUnavailable.WALLET_SCOPE_NOT_SNAPSHOTTED);
  });

  it('refuses the growth decomposition', () => {
    expect(absent(run(WALLET_SCOPE).decomposition)).toBe(
      HistoryUnavailable.WALLET_SCOPE_NOT_SNAPSHOTTED,
    );
  });

  it('refuses the monthly contribution bars', () => {
    expect(absent(run(WALLET_SCOPE).monthlyContributions)).toBe(
      HistoryUnavailable.WALLET_SCOPE_NOT_SNAPSHOTTED,
    );
  });

  /**
   * The distinction the two reasons exist for. `asset_class` is the one
   * dimension the snapshot *does* decompose along, so at portfolio scope it
   * bands happily — and at wallet scope it must still refuse, for the scope's
   * reason rather than the dimension's. A single reason code would have made
   * this case indistinguishable from "we don't store that breakdown", and the
   * message the user reads would have been about the wrong thing.
   */
  it('refuses the stacked bands for the one dimension it can normally band', () => {
    const walletScoped = run(WALLET_SCOPE, 'asset_class');
    expect(walletScoped.stacked.kind).toBe('unavailable');
    if (walletScoped.stacked.kind !== 'unavailable') return;
    expect(walletScoped.stacked.reason).toBe(HistoryUnavailable.WALLET_SCOPE_NOT_SNAPSHOTTED);
    expect(walletScoped.stacked.grouping).toBe('asset_class');

    // The same call at portfolio scope still bands, so the refusal is the
    // scope's and not a regression that broke the feature for everyone.
    expect(run(PORTFOLIO_SCOPE, 'asset_class').stacked.kind).toBe('available');
  });

  /**
   * BR-013-12 — **what survives**, and it is the point of not making this an
   * error page. `applyScope` sliced the holding set per wallet before it was
   * folded (SPEC-011 `scope.ts`), so the total is R$ 10.000 — this wallet's
   * money, the same figure Composition shows for the same scope and date.
   */
  it('still headlines the wallet’s own current value', () => {
    expect(to8(run(WALLET_SCOPE).headline.currentValue)).toBe('10000.00000000');
  });

  /** Facts about the request, not about the portfolio, so they hold anywhere. */
  it('still carries granularity and both freshness dates', () => {
    const result = run(WALLET_SCOPE);
    expect(result.granularity).toBe('daily');
    expect(result.freshness.valuationAsOf).toBe('2026-03-31');
    expect(result.freshness.lastImportAt).toBe('2026-03-15');
  });

  /**
   * The same fixture at portfolio scope, asserting the figures the wallet
   * scope refuses are exactly the ones it used to borrow. Hand-computed:
   *
   *   totalInvested = 400.000                       (the closing snapshot)
   *   absoluteGain  = 10.000 − 400.000 = −390.000
   *   gainRatio     = −390.000 ÷ 400.000 = −0,975
   *
   * A portfolio genuinely worth 10.000 after contributing 400.000 *has* lost
   * 97,5 %, and this report says so. The defect was never the arithmetic; it
   * was pairing it with a scope it did not belong to.
   */
  it('produces those very figures at portfolio scope, where they are true', () => {
    const invested = present(run(PORTFOLIO_SCOPE).headline.invested);
    expect(to8(invested.totalInvested)).toBe('400000.00000000');
    expect(to8(invested.absoluteGain)).toBe('-390000.00000000');
    expect(to8(invested.gainRatio!)).toBe('-0.97500000');

    const series: readonly ValuePoint[] = present(run(PORTFOLIO_SCOPE).series);
    expect(series.map((point) => point.value.toString())).toEqual(['400000', '10000']);

    const bars: readonly MonthlyContribution[] = present(run(PORTFOLIO_SCOPE).monthlyContributions);
    // 400.000 at the end of March against 400.000 at the end of February.
    expect(bars.map((bar) => `${bar.month}=${bar.amount.toString()}`)).toEqual(['2026-03=0']);
  });
});
