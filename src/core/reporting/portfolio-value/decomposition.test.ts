import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money } from '@/core/shared/money';
import type { AssetClass } from '@/core/quotes/ports';
import type { DailyValuationSnapshot } from '@/core/valuation/ports';
import { decomposeGrowth, investedFigures } from './decomposition';

/**
 * SPEC-013 BR-013-02/03/04.
 *
 * **What these tests are actually for.** The reconciliation
 * `closing − opening = contributions + priceChange + earnings` holds by
 * construction — `priceChange` is the residual — so asserting it proves only
 * that nobody has refactored the subtraction away. The defects that can
 * actually reach a user are miscounted *contributions* and miscounted
 * *earnings*, because those are the two figures read from the snapshot and
 * either one being wrong quietly moves the same amount into or out of price
 * change. So the driver assertions below carry hand-computed expectations
 * (TS-04) and the reconciliation assertion is the cheap regression guard.
 */

const d = (value: string): BusinessDate => BusinessDate.of(value);
const m = (value: string): Money => Money.fromString(value);
const to8 = (value: Money): string => value.toDecimal().toFixed(8);

function snapshot(
  date: string,
  totalValue: string,
  netContributions: string,
  earningsToDate: string,
  options: { hasEstimates?: boolean; byAssetClass?: ReadonlyMap<AssetClass, Money> } = {},
): DailyValuationSnapshot {
  return {
    date: d(date),
    totalValue: m(totalValue),
    netContributions: m(netContributions),
    earningsToDate: m(earningsToDate),
    byAssetClass: options.byAssetClass ?? new Map<AssetClass, Money>(),
    hasEstimates: options.hasEstimates ?? false,
  };
}

describe('decomposeGrowth (BR-013-02/03)', () => {
  /**
   * AC — "a period with a large deposit and flat prices shows the growth
   * entirely as contributions and **zero** as price change".
   *
   *   opening  100.000, contributed 100.000, earned 0
   *   closing  150.000, contributed 150.000, earned 0
   *
   *   contributions = 150.000 − 100.000 = 50.000
   *   earnings      =       0 −       0 =      0
   *   growth        = 150.000 − 100.000 = 50.000
   *   price change  =  50.000 − 50.000 − 0 = **0**
   *
   * This is the report's reason to exist: R$50k of deposits must not look
   * like R$50k of performance.
   */
  it('attributes a deposit into flat prices entirely to contributions', () => {
    const result = decomposeGrowth({
      opening: snapshot('2026-02-28', '100000', '100000', '0'),
      closing: snapshot('2026-03-31', '150000', '150000', '0'),
    });

    expect(to8(result.netContributions)).toBe('50000.00000000');
    expect(to8(result.priceChange)).toBe('0.00000000');
    expect(to8(result.earnings)).toBe('0.00000000');
  });

  /**
   * AC — "a period with no deposits and rising prices shows growth entirely
   * as price change".
   *
   *   contributions = 100.000 − 100.000 = 0
   *   growth        = 118.500 − 100.000 = 18.500
   *   price change  = 18.500 − 0 − 0    = 18.500
   */
  it('attributes a rise with no deposits entirely to price change', () => {
    const result = decomposeGrowth({
      opening: snapshot('2026-02-28', '100000', '100000', '0'),
      closing: snapshot('2026-03-31', '118500', '100000', '0'),
    });

    expect(to8(result.netContributions)).toBe('0.00000000');
    expect(to8(result.priceChange)).toBe('18500.00000000');
  });

  /**
   * AC — "a dividend-heavy period attributes the correct amount to earnings
   * and not to price change". DL-013-03: folding earnings into price change
   * destroys exactly the distinction an income investor is reading for.
   *
   *   contributions = 100.000 − 100.000 =      0
   *   earnings      =   3.200 −       0 =  3.200
   *   growth        = 104.700 − 100.000 =  4.700
   *   price change  =   4.700 − 0 − 3.200 = **1.500**
   */
  it('separates earnings from price change rather than folding them together', () => {
    const result = decomposeGrowth({
      opening: snapshot('2026-02-28', '100000', '100000', '0'),
      closing: snapshot('2026-03-31', '104700', '100000', '3200'),
    });

    expect(to8(result.earnings)).toBe('3200.00000000');
    expect(to8(result.priceChange)).toBe('1500.00000000');
  });

  /**
   * BR-013-08 — a net withdrawal is a negative contribution, and the value
   * fall it causes must not be read as the market falling.
   *
   *   contributions =  92.000 − 100.000 = −8.000
   *   growth        =  93.400 − 100.000 = −6.600
   *   price change  =  −6.600 − (−8.000) − 0 = **+1.400**
   *
   * The portfolio shrank while the market gained. Anything that reported this
   * period as a loss would be describing the withdrawal, not the investments.
   */
  it('reads a withdrawal as a negative contribution, not as a market fall', () => {
    const result = decomposeGrowth({
      opening: snapshot('2026-02-28', '100000', '100000', '0'),
      closing: snapshot('2026-03-31', '93400', '92000', '0'),
    });

    expect(to8(result.netContributions)).toBe('-8000.00000000');
    expect(to8(result.priceChange)).toBe('1400.00000000');
  });

  /**
   * A first period has no preceding snapshot. Opening at zero is what makes a
   * brand-new account's whole value show as contributions rather than as
   * unexplained price change.
   */
  it('opens at zero when nothing precedes the range', () => {
    const result = decomposeGrowth({
      opening: null,
      closing: snapshot('2026-03-31', '25000', '25000', '0'),
    });

    expect(to8(result.opening)).toBe('0.00000000');
    expect(to8(result.netContributions)).toBe('25000.00000000');
    expect(to8(result.priceChange)).toBe('0.00000000');
  });

  it('returns zeros rather than failing when the range holds no snapshot', () => {
    const result = decomposeGrowth({ opening: null, closing: null });
    expect(to8(result.closing)).toBe('0.00000000');
    expect(to8(result.priceChange)).toBe('0.00000000');
  });

  /**
   * BR-013-03, asserted across several periods as the AC requires — with the
   * caveat in this file's header that it is a regression guard rather than a
   * discovery. Deliberately includes messy repeating decimals: the identity
   * must hold exactly at full precision, not to two places, which is what
   * would break first if a `number` ever leaked into one of these paths
   * (TS-11).
   */
  it.each([
    ['flat', '100000', '100000', '0', '150000', '150000', '0'],
    ['growth', '100000', '100000', '0', '118500', '100000', '0'],
    ['income', '100000', '100000', '0', '104700', '100000', '3200'],
    ['withdrawal', '100000', '100000', '0', '93400', '92000', '0'],
    [
      'thirds',
      '10000.33333333',
      '9999.66666667',
      '0.11111111',
      '13333.99999999',
      '11111.22222222',
      '333.33333333',
    ],
  ])(
    'reconciles: closing − opening = contributions + price change + earnings (%s)',
    (_name, ov, oc, oe, cv, cc, ce) => {
      const result = decomposeGrowth({
        opening: snapshot('2026-02-28', ov, oc, oe),
        closing: snapshot('2026-03-31', cv, cc, ce),
      });

      const left = result.closing.minus(result.opening);
      const right = result.netContributions.plus(result.priceChange).plus(result.earnings);
      expect(to8(left)).toBe(to8(right));
    },
  );
});

describe('investedFigures (BR-013-04)', () => {
  /**
   * The current value comes from the **valued holdings**, not from the
   * snapshot — BR-013-12/DL-013-06. The snapshot here deliberately carries a
   * different total (149.000) so a regression that read it instead would show
   * up as a wrong headline rather than as a passing test. (The value itself is
   * asserted on the assembled report, in `report.test.ts`; this function is
   * handed it and returns only what it derives from the snapshot.)
   *
   *   invested = 120.000
   *   gain     = 150.000 − 120.000 = 30.000
   *   %        = 30.000 / 120.000 × 100 = 25
   */
  it('measures the gain against the snapshot’s contributions', () => {
    const result = investedFigures(m('150000'), snapshot('2026-03-31', '149000', '120000', '0'));

    expect(to8(result.totalInvested)).toBe('120000.00000000');
    expect(to8(result.absoluteGain)).toBe('30000.00000000');
    expect(to8(result.gainRatio!)).toBe('0.25000000');
  });

  it('reports a loss as a negative gain in both forms', () => {
    // 90.000 − 120.000 = −30.000; −30.000 / 120.000 × 100 = −25
    const result = investedFigures(m('90000'), snapshot('2026-03-31', '90000', '120000', '0'));
    expect(to8(result.absoluteGain)).toBe('-30000.00000000');
    expect(to8(result.gainRatio!)).toBe('-0.25000000');
  });

  /**
   * A percentage of nothing invested is undefined, not infinite. Rendering
   * `Infinity%` beside somebody's *patrimônio* is worse than rendering an em
   * dash, and `null` is what lets the UI tell the difference.
   */
  it('declines a ratio when nothing is invested', () => {
    expect(investedFigures(m('500'), snapshot('2026-03-31', '500', '0', '500')).gainRatio).toBe(
      null,
    );
  });

  it('declines a ratio when more has been withdrawn than was ever put in', () => {
    const result = investedFigures(m('4000'), snapshot('2026-03-31', '4000', '-2500', '0'));
    expect(result.gainRatio).toBe(null);
    // The absolute gain is still meaningful and still reported.
    expect(to8(result.absoluteGain)).toBe('6500.00000000');
  });

  it('treats a missing closing snapshot as nothing invested', () => {
    const result = investedFigures(m('0'), null);
    expect(to8(result.totalInvested)).toBe('0.00000000');
    expect(result.gainRatio).toBe(null);
  });
});
