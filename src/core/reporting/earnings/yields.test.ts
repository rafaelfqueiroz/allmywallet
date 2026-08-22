import { describe, expect, it } from 'vitest';
import { Money, Quantity } from '@/core/shared/money';
import type { AssetId } from '@/core/shared/ids';
import type { EarningRecord, ReportHolding } from '@/core/reporting/ports';
import { assetIncomeRows, incomeByAsset, scopeYieldOnCost } from '@/core/reporting/earnings/yields';
import { aHolding, assetIdOf, day, institutionIdOf } from '@/core/reporting/test-support';

/**
 * SPEC-014 BR-014-05/06 / DL-014-01 — **the two yields answer different
 * questions and must never be conflated.**
 *
 * The worked example is the spec's own: bought at R$ 10, now paying R$ 1,20 a
 * year, now trading at R$ 40. Yield on cost 12 %, current yield 3 %. Both are
 * true; only one of them describes the holder.
 */

const PETR = assetIdOf('1');
const ITSA = assetIdOf('2');

const earning = (assetId: AssetId, amount: string): EarningRecord => ({
  assetId,
  institutionId: institutionIdOf('1'),
  type: 'dividend',
  payDate: day('2026-03-10'),
  amount: Money.fromString(amount),
  quantity: Quantity.fromString('100'),
});

/** 100 shares bought at 10, now worth 40 each. */
const bought = (assetId: AssetId, code: string): ReportHolding =>
  aHolding({
    assetId,
    assetCode: code,
    assetName: `Ativo ${code}`,
    quantity: Quantity.fromString('100'),
    costBasis: Money.fromString('1000'),
    value: Money.fromString('4000'),
  });

describe('incomeByAsset', () => {
  it('folds several payments per asset', () => {
    const totals = incomeByAsset([earning(PETR, '80'), earning(PETR, '40'), earning(ITSA, '10')]);
    expect(totals.get(PETR)?.toString()).toBe('120');
    expect(totals.get(ITSA)?.toString()).toBe('10');
  });
});

describe('assetIncomeRows (BR-014-05/06)', () => {
  const names = new Map<AssetId, { code: string; name: string }>();

  it('computes yield on cost against what was paid, not what it is worth', () => {
    const rows = assetIncomeRows({
      periodIncome: new Map([[PETR, Money.fromString('120')]]),
      trailingIncome: new Map([[PETR, Money.fromString('120')]]),
      holdings: [bought(PETR, 'PETR4')],
      names,
    });

    // 120 ÷ 1.000 = 12 %.
    expect(rows[0]?.yieldOnCost?.toString()).toBe('0.12');
  });

  it('computes current yield against today’s value, and the two differ', () => {
    const rows = assetIncomeRows({
      periodIncome: new Map([[PETR, Money.fromString('120')]]),
      trailingIncome: new Map([[PETR, Money.fromString('120')]]),
      holdings: [bought(PETR, 'PETR4')],
      names,
    });

    // 120 ÷ 4.000 = 3 %. The whole reason both are reported.
    expect(rows[0]?.currentYield?.toString()).toBe('0.03');
    expect(rows[0]?.yieldOnCost?.equals(rows[0]?.currentYield as Money)).toBe(false);
  });

  /**
   * BR-014-06's window is fixed at twelve months whatever period is selected.
   * A current yield computed over a three-month period would read as a quarter
   * of the real one, which is a wrong number rather than a narrow one.
   */
  it('takes current yield from the trailing window, not from the selected period', () => {
    const rows = assetIncomeRows({
      periodIncome: new Map([[PETR, Money.fromString('30')]]),
      trailingIncome: new Map([[PETR, Money.fromString('120')]]),
      holdings: [bought(PETR, 'PETR4')],
      names,
    });

    expect(rows[0]?.amount.toString()).toBe('30');
    expect(rows[0]?.currentYield?.toString()).toBe('0.03');
  });

  /**
   * Selling in March does not unmake February's income. Dropping the row
   * would make the per-asset rows stop summing to the period total.
   */
  it('keeps an asset that paid and is no longer held, with no yields', () => {
    const rows = assetIncomeRows({
      periodIncome: new Map([[ITSA, Money.fromString('50')]]),
      trailingIncome: new Map([[ITSA, Money.fromString('50')]]),
      holdings: [],
      names: new Map([[ITSA, { code: 'ITSA4', name: 'Itaúsa PN' }]]),
    });

    expect(rows[0]?.assetCode).toBe('ITSA4');
    expect(rows[0]?.amount.toString()).toBe('50');
    // Not zero: "we cannot compute this" and "this yields nothing" are
    // different statements, and only one of them is true.
    expect(rows[0]?.yieldOnCost).toBeNull();
    expect(rows[0]?.currentYield).toBeNull();
  });

  it('falls back to the asset id when nothing describes it', () => {
    const rows = assetIncomeRows({
      periodIncome: new Map([[ITSA, Money.fromString('50')]]),
      trailingIncome: new Map(),
      holdings: [],
      names: new Map(),
    });
    expect(rows[0]?.assetCode).toBe(ITSA);
  });

  it('declines both yields for a holding recorded at no cost and no value', () => {
    const rows = assetIncomeRows({
      periodIncome: new Map([[PETR, Money.fromString('10')]]),
      trailingIncome: new Map([[PETR, Money.fromString('10')]]),
      holdings: [aHolding({ assetId: PETR, costBasis: Money.zero(), value: Money.zero() })],
      names,
    });

    expect(rows[0]?.yieldOnCost).toBeNull();
    expect(rows[0]?.currentYield).toBeNull();
  });

  it('folds a position held at two institutions into one row', () => {
    const rows = assetIncomeRows({
      periodIncome: new Map([[PETR, Money.fromString('120')]]),
      trailingIncome: new Map([[PETR, Money.fromString('120')]]),
      holdings: [
        aHolding({
          assetId: PETR,
          institutionId: institutionIdOf('1'),
          costBasis: Money.fromString('600'),
          value: Money.fromString('2400'),
        }),
        aHolding({
          assetId: PETR,
          institutionId: institutionIdOf('2'),
          costBasis: Money.fromString('400'),
          value: Money.fromString('1600'),
        }),
      ],
      names,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.yieldOnCost?.toString()).toBe('0.12');
  });

  it('ranks by income, and breaks a tie by code so the order is stable', () => {
    const rows = assetIncomeRows({
      periodIncome: new Map([
        [PETR, Money.fromString('50')],
        [ITSA, Money.fromString('50')],
      ]),
      trailingIncome: new Map(),
      holdings: [bought(PETR, 'PETR4'), bought(ITSA, 'ITSA4')],
      names,
    });

    expect(rows.map((row) => row.assetCode)).toEqual(['ITSA4', 'PETR4']);
  });

  it('puts the larger payer first', () => {
    const rows = assetIncomeRows({
      periodIncome: new Map([
        [PETR, Money.fromString('10')],
        [ITSA, Money.fromString('90')],
      ]),
      trailingIncome: new Map(),
      holdings: [bought(PETR, 'PETR4'), bought(ITSA, 'ITSA4')],
      names,
    });

    expect(rows.map((row) => row.assetCode)).toEqual(['ITSA4', 'PETR4']);
  });
});

describe('scopeYieldOnCost (BR-014-05)', () => {
  /**
   * Over the whole scope's cost, including holdings that paid nothing: a
   * portfolio's yield on cost is what the money as a whole produced, and
   * excluding the non-payers would describe a portfolio the user does not own.
   */
  it('divides the period’s income by every holding’s cost, payer or not', () => {
    const scoped = scopeYieldOnCost(Money.fromString('120'), [
      bought(PETR, 'PETR4'),
      bought(ITSA, 'ITSA4'),
    ]);
    // 120 ÷ 2.000, not 120 ÷ 1.000.
    expect(scoped?.toString()).toBe('0.06');
  });

  it('declines when the scope has no recorded cost', () => {
    expect(scopeYieldOnCost(Money.fromString('120'), [])).toBeNull();
  });
});
