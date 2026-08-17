import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money } from '@/core/shared/money';
import type { AssetClass } from '@/core/quotes/ports';
import type { DailyValuationSnapshot } from '@/core/valuation/ports';
import { HistoryUnavailable } from './ports';
import {
  granularityFor,
  monthlyContributions,
  stackedSeries,
  valueSeries,
  weekOf,
  withLiveEndpoint,
} from './series';

/**
 * SPEC-013 BR-013-01/05/06/07/10.
 *
 * The defect this file is mostly aimed at: **treating a stock like a flow**.
 * Portfolio value is a point-in-time quantity, so a monthly bucket is the
 * month's *closing* figure; net contributions are a genuine flow, so a monthly
 * bar is the month's *sum*. Swapping them produces a chart that looks entirely
 * plausible and is off by a factor of thirty.
 */

const d = (value: string): BusinessDate => BusinessDate.of(value);
const m = (value: string): Money => Money.fromString(value);
const to8 = (value: Money): string => value.toDecimal().toFixed(8);

function snapshot(
  date: string,
  totalValue: string,
  netContributions = '0',
  options: { hasEstimates?: boolean; byAssetClass?: ReadonlyMap<AssetClass, Money> } = {},
): DailyValuationSnapshot {
  return {
    date: d(date),
    totalValue: m(totalValue),
    netContributions: m(netContributions),
    earningsToDate: Money.zero(),
    byAssetClass: options.byAssetClass ?? new Map<AssetClass, Money>(),
    hasEstimates: options.hasEstimates ?? false,
  };
}

describe('granularityFor (BR-013-01)', () => {
  it.each([
    ['2026-01-01', '2026-03-31', 'daily'],
    ['2026-01-01', '2026-06-29', 'daily'],
    // 180 days is the last daily day; 181 rolls up.
    ['2026-01-01', '2026-07-01', 'weekly'],
    ['2026-01-01', '2027-12-31', 'weekly'],
    ['2026-01-01', '2028-01-02', 'monthly'],
  ])('%s → %s is %s', (from, to, expected) => {
    expect(granularityFor(d(from), d(to))).toBe(expected);
  });
});

describe('weekOf', () => {
  /**
   * Sunday is the *end* of its ISO week, not the start of the next one. The
   * naive `getUTCDay()` shift puts it a week out, which would scatter a
   * weekend's snapshots into the following bucket.
   */
  it.each([
    ['2026-03-16', '2026-03-16'], // Monday → itself
    ['2026-03-18', '2026-03-16'], // Wednesday
    ['2026-03-22', '2026-03-16'], // Sunday → the same Monday
    ['2026-03-23', '2026-03-23'], // the next Monday
  ])('%s falls in the week starting %s', (date, expected) => {
    expect(weekOf(d(date))).toBe(expected);
  });
});

describe('valueSeries (BR-013-01) — value is a stock', () => {
  it('takes each bucket’s closing value, never a sum', () => {
    // Three days in one month totalling 300 if wrongly summed. The month's
    // value is 120 — what the portfolio was worth at the end of it.
    const series = valueSeries(
      [snapshot('2026-03-02', '100'), snapshot('2026-03-15', '80'), snapshot('2026-03-31', '120')],
      'monthly',
    );

    expect(series).toHaveLength(1);
    expect(to8(series[0]!.value)).toBe('120.00000000');
    expect(series[0]!.date).toBe('2026-03-31');
  });

  it('keeps every day at daily granularity', () => {
    const series = valueSeries(
      [snapshot('2026-03-02', '100'), snapshot('2026-03-03', '110')],
      'daily',
    );
    expect(series.map((point) => point.date)).toEqual(['2026-03-02', '2026-03-03']);
  });

  it('buckets by ISO week, so a weekend lands with the week it ends', () => {
    const series = valueSeries(
      [
        snapshot('2026-03-16', '100'), // Monday
        snapshot('2026-03-22', '130'), // Sunday, same week
        snapshot('2026-03-23', '140'), // next Monday
      ],
      'weekly',
    );
    expect(series).toHaveLength(2);
    expect(to8(series[0]!.value)).toBe('130.00000000');
  });

  /**
   * BR-013-07 — a month containing *any* accrued figure is partly computed.
   * Reading the flag off the closing row alone would clear the marker
   * whenever the last day of the month happened to be fully observed.
   */
  it('marks a bucket estimated when any day in it was', () => {
    const series = valueSeries(
      [
        snapshot('2026-03-02', '100', '0', { hasEstimates: true }),
        snapshot('2026-03-31', '120', '0', { hasEstimates: false }),
      ],
      'monthly',
    );
    expect(series[0]!.estimated).toBe(true);
  });

  it('returns nothing for no snapshots rather than a zero point', () => {
    expect(valueSeries([], 'daily')).toEqual([]);
  });
});

describe('withLiveEndpoint (BR-013-10 / DL-013-05)', () => {
  const today = d('2026-03-31');

  it('replaces today’s snapshot point with the live valuation', () => {
    const series = valueSeries(
      [snapshot('2026-03-30', '100'), snapshot('2026-03-31', '110')],
      'daily',
    );
    const result = withLiveEndpoint(series, today, m('117.50'), false, today);

    expect(result).toHaveLength(2);
    expect(to8(result[1]!.value)).toBe('117.50000000');
  });

  it('extends the line when today has no snapshot yet', () => {
    const series = valueSeries([snapshot('2026-03-30', '100')], 'daily');
    const result = withLiveEndpoint(series, today, m('117.50'), false, today);

    expect(result).toHaveLength(2);
    expect(result[1]!.date).toBe('2026-03-31');
  });

  /**
   * The rule that makes the chart trustworthy: a report *about a past date*
   * gets that date's close, not today's quote. Otherwise the same historical
   * point renders differently depending on what time the page was loaded.
   */
  it('leaves a historical report’s endpoint alone', () => {
    const series = valueSeries(
      [snapshot('2026-02-27', '100'), snapshot('2026-02-28', '105')],
      'daily',
    );
    const result = withLiveEndpoint(series, d('2026-02-28'), m('999'), false, today);

    expect(to8(result.at(-1)!.value)).toBe('105.00000000');
  });

  it('carries the live estimate flag onto the endpoint', () => {
    const result = withLiveEndpoint([], today, m('10'), true, today);
    expect(result[0]!.estimated).toBe(true);
  });
});

describe('monthlyContributions (BR-013-06) — contributions are a flow', () => {
  /**
   * The cumulative column differenced month over month:
   *
   *   Jan close 1.000 − opening   0 = 1.000
   *   Feb close 3.500 − 1.000       = 2.500
   *   Mar close 3.000 − 3.500       = **−500**  (a net withdrawal)
   */
  it('differences the running total, and goes negative on a withdrawal', () => {
    const bars = monthlyContributions(
      [
        snapshot('2026-01-31', '1000', '1000'),
        snapshot('2026-02-28', '3600', '3500'),
        snapshot('2026-03-31', '3100', '3000'),
      ],
      null,
    );

    expect(bars.map((bar) => bar.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(bars.map((bar) => to8(bar.amount))).toEqual([
      '1000.00000000',
      '2500.00000000',
      '-500.00000000',
    ]);
  });

  /**
   * Without the opening anchor the first bar would be the entire cumulative
   * total to date — an existing balance rendered as one enormous deposit in
   * whatever month the range happens to start.
   */
  it('anchors the first month against the preceding snapshot', () => {
    const bars = monthlyContributions(
      [snapshot('2026-03-31', '52000', '50000')],
      snapshot('2026-02-28', '48000', '47000'),
    );
    expect(to8(bars[0]!.amount)).toBe('3000.00000000');
  });

  it('uses the month’s last snapshot as its cumulative close', () => {
    const bars = monthlyContributions(
      [snapshot('2026-03-10', '1000', '900'), snapshot('2026-03-31', '1200', '1100')],
      null,
    );
    expect(bars).toHaveLength(1);
    expect(to8(bars[0]!.amount)).toBe('1100.00000000');
  });
});

describe('stackedSeries (BR-013-05)', () => {
  const classes = (entries: readonly [AssetClass, string][]): ReadonlyMap<AssetClass, Money> =>
    new Map(entries.map(([key, value]) => [key, m(value)]));

  it('bands an asset-class breakdown that sums to the total line', () => {
    const rows = [
      snapshot('2026-03-31', '1000', '0', {
        byAssetClass: classes([
          ['stock', '600'],
          ['cdb', '400'],
        ]),
      }),
    ];

    const result = stackedSeries(rows, 'monthly', 'asset_class');
    expect(result.kind).toBe('available');
    if (result.kind !== 'available') return;

    const total = result.bands.reduce((sum, band) => sum.plus(band.points[0]!.value), Money.zero());
    // The bands are components of the very figure the line is drawn from, so
    // they sum to it by construction rather than by reconciliation.
    expect(to8(total)).toBe(to8(rows[0]!.totalValue));
  });

  it('rolls bands up to the same buckets as the line', () => {
    const result = stackedSeries(
      [
        snapshot('2026-03-02', '100', '0', { byAssetClass: classes([['stock', '100']]) }),
        snapshot('2026-03-31', '150', '0', { byAssetClass: classes([['stock', '150']]) }),
      ],
      'monthly',
      'asset_class',
    );

    if (result.kind !== 'available') throw new Error('unreachable');
    expect(result.bands[0]!.points).toHaveLength(1);
    expect(to8(result.bands[0]!.points[0]!.value)).toBe('150.00000000');
  });

  /**
   * The honest refusal. `by_asset_class` is the only historical breakdown
   * stored, so the other four dimensions cannot be banded — and returning
   * empty bands would render as "you held nothing", a false statement about
   * someone's portfolio rather than a true one about the product.
   */
  it.each(['wallet', 'institution', 'asset', 'sector'] as const)(
    'declines to band %s, naming why',
    (grouping) => {
      const result = stackedSeries([snapshot('2026-03-31', '1000')], 'monthly', grouping);
      expect(result.kind).toBe('unavailable');
      if (result.kind !== 'unavailable') return;
      expect(result.reason).toBe(HistoryUnavailable.NO_HISTORICAL_BREAKDOWN);
      expect(result.grouping).toBe(grouping);
    },
  );
});
