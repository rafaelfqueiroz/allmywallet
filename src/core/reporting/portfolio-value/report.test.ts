import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import type { AssetClass } from '@/core/quotes/ports';
import type { DailyValuationSnapshot } from '@/core/valuation/ports';
import type { ReportQueryResult } from '@/core/reporting/base-query';
import type { GroupedReport } from '@/core/reporting/ports';
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
 */

const d = (value: string): BusinessDate => BusinessDate.of(value);
const m = (value: string): Money => Money.fromString(value);
const to8 = (value: Money): string => value.toDecimal().toFixed(8);

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
  options: { from?: string; to?: string; asOf?: string; estimated?: boolean } = {},
): ReportQueryResult {
  const from = d(options.from ?? '2026-03-01');
  const to = d(options.to ?? '2026-03-31');
  return {
    range: { from, to },
    asOf: d(options.asOf ?? '2026-03-31'),
    scope: { scope: { kind: 'portfolio' }, wallet: null },
    report: groupedReport(holdingsTotal, options.estimated ?? false),
    snapshots,
    empty: snapshots.length === 0,
  };
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
    expect(to8(result.series.at(-1)!.value)).toBe('150000.00000000');
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

    expect(to8(result.decomposition.netContributions)).toBe('10000.00000000');
    expect(to8(result.decomposition.priceChange)).toBe('20000.00000000');
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

    expect(to8(result.decomposition.closing)).toBe('0.00000000');
    expect(result.monthlyContributions).toEqual([]);
    expect(result.headline.gainRatio).toBe(null);
    // The live endpoint still applies: asOf is today, so the series is the
    // single live point rather than nothing at all.
    expect(result.series).toHaveLength(1);
  });

  it('carries the live estimate flag onto the endpoint', () => {
    const result = buildPortfolioValueReport({
      query: query([snapshot('2026-03-31', '100')], '100', { estimated: true }),
      opening: null,
      grouping: 'asset_class',
      today,
      lastImportAt: null,
    });
    expect(result.series.at(-1)!.estimated).toBe(true);
  });
});
