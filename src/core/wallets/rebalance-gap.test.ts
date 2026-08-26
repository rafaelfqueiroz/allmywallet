import { describe, expect, it } from 'vitest';
import { AssetId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { rebalanceGap, toTradablePrecision } from '@/core/wallets/rebalance-gap';

/**
 * SPEC-017 BR-017-18/20 — the gap in percentage points, in R$ and in cotas,
 * in both directions.
 *
 * TS-04: every figure is hand-computed. The worked example runs through the
 * whole file, so the three expressions of one gap can be checked against each
 * other rather than each against itself:
 *
 *   targeted value  R$ 1.000,00
 *   PETR4           R$   140,00  =  14 %,  target 10 %
 *   target value    1.000 × 10 ÷ 100      =  R$ 100,00
 *   gap in R$       100 − 140             =  −R$ 40,00   (overweight)
 *   unit price      140 ÷ 10 cotas        =  R$  14,00
 *   gap in cotas    −40 ÷ 14              =  −2,857…     → −2 at tradable precision
 *   gap in pp       10 − 14               =  −4 pp
 *
 * and the reconciliation: −4 pp of R$ 1.000 is −R$ 40, and −2,857… cotas at
 * R$ 14 is −R$ 40. Three statements of the same distance.
 */

const PETR = AssetId.generate();

const overweight = {
  assetId: PETR,
  targetPct: Quantity.fromString('10'),
  currentPct: Quantity.fromString('14'),
  value: Money.fromString('140'),
  quantity: Quantity.fromString('10'),
  targetedValue: Money.fromString('1000'),
};

describe('BR-017-18 — an overweight asset', () => {
  it('states the distance in percentage points, R$ and cotas', () => {
    const gap = rebalanceGap(overweight);

    expect(gap.gapPp.toString()).toBe('-4');
    expect(gap.gapValue.toString()).toBe('-40');
    expect(gap.unitPrice?.toString()).toBe('14');
    expect(gap.gapShares?.toString().startsWith('-2.857142857')).toBe(true);
    expect(gap.tradableShares?.toString()).toBe('-2');
  });

  it('reconciles: the pp gap over the targeted value equals the R$ gap', () => {
    const gap = rebalanceGap(overweight);
    const fromPoints = Money.fromString(gap.gapPp.toString())
      .times(overweight.targetedValue.toString())
      .dividedBy('100');
    expect(fromPoints.equals(gap.gapValue)).toBe(true);
  });

  it('reconciles the other way: cotas × unit price equals the R$ gap', () => {
    /*
     * Exact only when the quotient terminates, so the fixture is chosen so it
     * does: R$ 100 of gap at R$ 10 a share is exactly −10 cotas. The
     * non-terminating case above is asserted on its digits instead, because
     * multiplying a 40-digit truncation back up cannot return the original
     * — and pretending otherwise would be the test lying about what the
     * arithmetic guarantees.
     */
    const gap = rebalanceGap({
      assetId: PETR,
      targetPct: Quantity.fromString('20'),
      currentPct: Quantity.fromString('30'),
      value: Money.fromString('300'),
      quantity: Quantity.fromString('30'),
      targetedValue: Money.fromString('1000'),
    });

    expect(gap.unitPrice?.toString()).toBe('10');
    expect(gap.gapValue.toString()).toBe('-100');
    expect(gap.gapShares?.toString()).toBe('-10');
    expect(
      Money.fromString(gap.gapShares?.toString() ?? '0')
        .times(gap.unitPrice?.toString() ?? '0')
        .equals(gap.gapValue),
    ).toBe(true);
  });
});

describe('BR-017-18 / DL-017-07 — the same three figures for an underweight asset', () => {
  it('produces positive figures, mirroring the overweight case exactly', () => {
    /*
     *   target value   1.000 × 30 ÷ 100 = R$ 300,00
     *   gap in R$      300 − 200        = +R$ 100,00
     *   unit price     200 ÷ 20 cotas   = R$  10,00
     *   gap in cotas   100 ÷ 10         = +10
     *   gap in pp      30 − 20          = +10 pp
     */
    const gap = rebalanceGap({
      assetId: PETR,
      targetPct: Quantity.fromString('30'),
      currentPct: Quantity.fromString('20'),
      value: Money.fromString('200'),
      quantity: Quantity.fromString('20'),
      targetedValue: Money.fromString('1000'),
    });

    expect(gap.gapPp.toString()).toBe('10');
    expect(gap.gapValue.toString()).toBe('100');
    expect(gap.gapShares?.toString()).toBe('10');
    expect(gap.tradableShares?.toString()).toBe('10');
  });

  it('an asset exactly on target has a gap of zero in all three units', () => {
    const gap = rebalanceGap({
      assetId: PETR,
      targetPct: Quantity.fromString('25'),
      currentPct: Quantity.fromString('25'),
      value: Money.fromString('250'),
      quantity: Quantity.fromString('25'),
      targetedValue: Money.fromString('1000'),
    });

    expect(gap.gapPp.isZero()).toBe(true);
    expect(gap.gapValue.isZero()).toBe(true);
    expect(gap.gapShares?.isZero()).toBe(true);
    expect(gap.tradableShares?.toString()).toBe('0');
  });
});

describe('BR-017-20 — tradable precision', () => {
  /**
   * Truncation **toward zero**, in both directions, so the count never
   * overstates the distance. On a screen whose whole footing is that it adds
   * no opinion, rounding 4,8 up to 5 would be the product contributing a share
   * the arithmetic does not support.
   */
  it('truncates toward zero rather than rounding, on both signs', () => {
    expect(toTradablePrecision(Quantity.fromString('4.8')).toString()).toBe('4');
    expect(toTradablePrecision(Quantity.fromString('-4.8')).toString()).toBe('-4');
    expect(toTradablePrecision(Quantity.fromString('0.99')).toString()).toBe('0');
    expect(toTradablePrecision(Quantity.fromString('-0.99')).toString()).toBe('0');
    expect(toTradablePrecision(Quantity.fromString('7')).toString()).toBe('7');
  });
});

describe('the arithmetic that has no answer', () => {
  it('withholds the share count when the holding has no quantity to price from', () => {
    const gap = rebalanceGap({
      assetId: PETR,
      targetPct: Quantity.fromString('50'),
      currentPct: Quantity.zero(),
      value: Money.zero(),
      quantity: Quantity.zero(),
      targetedValue: Money.fromString('1000'),
    });

    // The R$ distance is still knowable and still stated — only the conversion
    // to cotas needs a unit price, and there is none.
    expect(gap.gapValue.toString()).toBe('500');
    expect(gap.unitPrice).toBeNull();
    expect(gap.gapShares).toBeNull();
    expect(gap.tradableShares).toBeNull();
  });

  it('withholds the share count when the holding is held but worth nothing', () => {
    const gap = rebalanceGap({
      assetId: PETR,
      targetPct: Quantity.fromString('50'),
      currentPct: Quantity.zero(),
      value: Money.zero(),
      quantity: Quantity.fromString('100'),
      targetedValue: Money.fromString('1000'),
    });

    // A unit price of zero would make the share count a division by zero; the
    // R$ figure is unaffected.
    expect(gap.unitPrice?.toString()).toBe('0');
    expect(gap.gapShares).toBeNull();
    expect(gap.gapValue.toString()).toBe('500');
  });
});
