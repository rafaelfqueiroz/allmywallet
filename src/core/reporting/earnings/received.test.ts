import { describe, expect, it } from 'vitest';
import { Money, Quantity } from '@/core/shared/money';
import type { EarningRecord, EarningType } from '@/core/reporting/ports';
import {
  monthlySeries,
  totalReceived,
  totalsByType,
  yearOverYear,
} from '@/core/reporting/earnings/received';
import { assetIdOf, day, institutionIdOf } from '@/core/reporting/test-support';

/**
 * SPEC-014 BR-014-01/02/03/07.
 *
 * The figures below are hand-computed (TS-04). Where a rule is about what is
 * *shown* rather than what is summed — a type at zero, a month with no
 * payment, an average that refuses to draw — the assertion is on the presence
 * or absence, because that is the behaviour a user sees.
 */

const PETR = assetIdOf('1');

const earning = (
  amount: string,
  payDate: string,
  type: EarningType = 'dividend',
): EarningRecord => ({
  assetId: PETR,
  institutionId: institutionIdOf('1'),
  type,
  payDate: day(payDate),
  amount: Money.fromString(amount),
  quantity: Quantity.fromString('100'),
});

describe('totalsByType (BR-014-01/02)', () => {
  it('separates JCP from dividends rather than folding them together', () => {
    const totals = totalsByType([
      earning('100', '2026-03-10', 'dividend'),
      earning('40', '2026-03-12', 'jcp'),
    ]);

    expect(totals.find((total) => total.type === 'dividend')?.amount.toString()).toBe('100');
    expect(totals.find((total) => total.type === 'jcp')?.amount.toString()).toBe('40');
  });

  /**
   * DL-014-02: the two are taxed differently in Brazil, so "proventos: 140"
   * cannot answer the question a user asks at tax time. Keeping them apart
   * costs nothing and preserves the information.
   */
  it('reports every type, including the ones that paid nothing', () => {
    const totals = totalsByType([earning('100', '2026-03-10', 'rendimento')]);

    expect(totals.map((total) => total.type)).toEqual([
      'dividend',
      'jcp',
      'rendimento',
      'amortization',
    ]);
    expect(totals.find((total) => total.type === 'amortization')?.amount.toString()).toBe('0');
  });

  it('sums the period, exactly', () => {
    expect(
      totalReceived([earning('0.01', '2026-01-10'), earning('0.02', '2026-02-10')]).toString(),
    ).toBe('0.03');
  });

  it('is zero for a period with no income, not an error', () => {
    expect(totalReceived([]).toString()).toBe('0');
    expect(totalsByType([]).every((total) => total.amount.isZero())).toBe(true);
  });
});

describe('monthlySeries (BR-014-03 / DL-014-03)', () => {
  const range = (from: string, to: string) => ({ from: day(from), to: day(to) });

  it('fills a month with no payment as zero rather than skipping it', () => {
    const series = monthlySeries([earning('100', '2026-01-15')], range('2026-01-01', '2026-03-31'));

    expect(series.map((month) => month.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(series[1]?.amount.toString()).toBe('0');
  });

  it('sums several payments landing in the same month', () => {
    const series = monthlySeries(
      [earning('100', '2026-01-15'), earning('50', '2026-01-28')],
      range('2026-01-01', '2026-01-31'),
    );
    expect(series[0]?.amount.toString()).toBe('150');
  });

  /**
   * The average is the point of the chart, and a partial one would slope
   * upward from the first month for arithmetic reasons alone. Refusing to draw
   * it until the window is full is the honest option.
   */
  it('withholds the moving average until twelve months exist', () => {
    const series = monthlySeries([], range('2026-01-01', '2026-11-30'));
    expect(series).toHaveLength(11);
    expect(series.every((month) => month.movingAverage === null)).toBe(true);
  });

  it('smooths a quarterly payer to a flat line once the window fills', () => {
    // 300 every third month over two years: the trailing twelve months always
    // contain exactly four payments, so the average is 1.200 ÷ 12 = 100 and it
    // does not move — which is precisely the trend the raw bars hide.
    const quarters = [
      '2025-01-15',
      '2025-04-15',
      '2025-07-15',
      '2025-10-15',
      '2026-01-15',
      '2026-04-15',
      '2026-07-15',
      '2026-10-15',
    ].map((date) => earning('300', date));

    const series = monthlySeries(quarters, range('2025-01-01', '2026-12-31'));

    const december2025 = series.find((month) => month.month === '2025-12');
    const december2026 = series.find((month) => month.month === '2026-12');
    expect(december2025?.movingAverage?.toString()).toBe('100');
    expect(december2026?.movingAverage?.toString()).toBe('100');
    // And the bars themselves stay lumpy — the average is added, not a
    // replacement for the monthly figure.
    expect(december2025?.amount.toString()).toBe('0');
  });

  it('spans a year boundary without losing a month', () => {
    const series = monthlySeries([], range('2025-11-01', '2026-02-28'));
    expect(series.map((month) => month.month)).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });

  /**
   * The caller passes earnings already filtered to the period, so this is a
   * belt-and-braces case — and the belt matters: a payment landing outside the
   * axis is added rather than dropped, because a monthly chart that quietly
   * omits income disagrees with the total printed above it.
   */
  it('keeps a payment that falls outside the seeded axis', () => {
    const series = monthlySeries([earning('100', '2026-05-15')], range('2026-01-01', '2026-03-31'));

    expect(series.find((month) => month.month === '2026-05')?.amount.toString()).toBe('100');
  });

  it('returns nothing for a range it cannot read', () => {
    // Defensive: `range` comes from a resolved period and is always two dates.
    // Producing an empty axis beats producing a NaN one, which would render as
    // a chart of months named "NaN-NaN".
    expect(monthlySeries([], { from: '', to: '' })).toEqual([]);
  });
});

describe('yearOverYear (BR-014-07)', () => {
  it('reports growth against the previous period', () => {
    const growth = yearOverYear(Money.fromString('1200'), Money.fromString('1000'));
    expect(growth.change?.toString()).toBe('0.2');
  });

  it('reports a fall as a negative change', () => {
    const growth = yearOverYear(Money.fromString('800'), Money.fromString('1000'));
    expect(growth.change?.toString()).toBe('-0.2');
  });

  /**
   * A first year of income has no growth rate — "up from nothing" is not a
   * percentage. Both amounts are still reported so the reader can see the
   * change themselves.
   */
  it('declines a rate when the previous period produced nothing', () => {
    const growth = yearOverYear(Money.fromString('1200'), Money.zero());
    expect(growth.change).toBeNull();
    expect(growth.current.toString()).toBe('1200');
    expect(growth.previous.toString()).toBe('0');
  });
});
