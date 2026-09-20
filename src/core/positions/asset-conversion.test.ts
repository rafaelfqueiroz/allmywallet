import { beforeEach, describe, expect, it } from 'vitest';
import type { Transaction } from '@/core/ledger/transaction';
import {
  aTransaction,
  assetIdFor,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import { type PositionSnapshot, replayPosition, replayPositions } from '@/core/positions/replay';

function stateFor(snapshots: readonly PositionSnapshot[], code: string) {
  return snapshots.find((snapshot) => snapshot.assetId === assetIdFor(code))?.state;
}

describe('SPEC-007 BR-007-05b — grouped asset conversions', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  it('moves 100 @ 10,00 into 50 target shares at exact total cost, with no realised gain', () => {
    // Source: 100 × 10,00 = 1.000,00.
    // conversion_out closes source: 0 shares / 0,00 cost / 0,00 gain.
    // conversion_in opens target: 50 shares / exactly 1.000,00 cost;
    // target average = 1.000,00 ÷ 50 = 20,00.
    const group = '00000000-c0de-7000-8000-000000000011';
    const ledger = [
      aTransaction().buy().of('OLD3').on('2026-01-05').quantity('100').price('10').build(),
      aTransaction()
        .conversionOut(group, '1000')
        .of('OLD3')
        .on('2026-06-01')
        .quantity('100')
        .build(),
      aTransaction()
        .conversionIn('1000.00000000', group)
        .of('NEW3')
        .on('2026-06-01')
        .quantity('50')
        .build(),
    ];

    const result = replayPositions(ledger);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const source = stateFor(result.value, 'OLD3');
    const target = stateFor(result.value, 'NEW3');
    expect(source?.quantity.toString()).toBe('0');
    expect(source?.totalCost.toString()).toBe('0');
    expect(source?.realizedGain.toString()).toBe('0');
    expect(target?.quantity.toString()).toBe('50');
    expect(target?.totalCost.toString()).toBe('1000');
    expect(target?.averageCost.toString()).toBe('20');
    expect(target?.realizedGain.toString()).toBe('0');
  });

  it('withdraws partial quantities from multiple sources at each moving average', () => {
    // SRC_A: 10 @ 10,00 = 100,00; remove 4 => carried 40,00, leaves 6 / 60,00.
    // SRC_B: 20 @  5,00 = 100,00; remove 10 => carried 50,00, leaves 10 / 50,00.
    // TARGET receives 5 shares and the exact combined 90,00 => average 18,00.
    const group = '00000000-c0de-7000-8000-000000000012';
    const result = replayPositions([
      aTransaction().buy().of('SRC_A').quantity('10').price('10').build(),
      aTransaction().buy().of('SRC_B').quantity('20').price('5').build(),
      aTransaction().conversionOut(group, '40').of('SRC_A').on('2026-02-01').quantity('4').build(),
      aTransaction().conversionOut(group, '50').of('SRC_B').on('2026-02-01').quantity('10').build(),
      aTransaction().conversionIn('90', group).of('TARGET').on('2026-02-01').quantity('5').build(),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sourceA = stateFor(result.value, 'SRC_A');
    const sourceB = stateFor(result.value, 'SRC_B');
    const target = stateFor(result.value, 'TARGET');
    expect(sourceA?.quantity.toString()).toBe('6');
    expect(sourceA?.totalCost.toString()).toBe('60');
    expect(sourceA?.averageCost.toString()).toBe('10');
    expect(sourceB?.quantity.toString()).toBe('10');
    expect(sourceB?.totalCost.toString()).toBe('50');
    expect(sourceB?.averageCost.toString()).toBe('5');
    expect(target?.quantity.toString()).toBe('5');
    expect(target?.totalCost.toString()).toBe('90');
    expect(target?.averageCost.toString()).toBe('18');
    expect(target?.realizedGain.toString()).toBe('0');
  });

  it('conserves a multi-source, multi-target group exactly at eight decimals', () => {
    // Source A: 3 × 33,33333333 =  99,99999999.
    // Source B: 7 × 14,28571429 = 100,00000003.
    // Removed total                    200,00000002.
    // Explicit target allocations: 133,33333335 + 66,66666667
    //                              = 200,00000002 exactly (8 decimals).
    const group = '00000000-c0de-7000-8000-000000000013';
    const result = replayPositions([
      aTransaction().buy().of('SRC_A').quantity('3').price('33.33333333').build(),
      aTransaction().buy().of('SRC_B').quantity('7').price('14.28571429').build(),
      aTransaction()
        .conversionOut(group, '99.99999999')
        .of('SRC_A')
        .on('2026-02-01')
        .quantity('3')
        .build(),
      aTransaction()
        .conversionOut(group, '100.00000003')
        .of('SRC_B')
        .on('2026-02-01')
        .quantity('7')
        .build(),
      aTransaction()
        .conversionIn('133.33333335', group)
        .of('TARGET_A')
        .on('2026-02-01')
        .quantity('4')
        .build(),
      aTransaction()
        .conversionIn('66.66666667', group)
        .of('TARGET_B')
        .on('2026-02-01')
        .quantity('2')
        .build(),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const targetA = stateFor(result.value, 'TARGET_A');
    const targetB = stateFor(result.value, 'TARGET_B');
    expect(targetA?.totalCost.toString()).toBe('133.33333335');
    expect(targetB?.totalCost.toString()).toBe('66.66666667');
    expect(targetA?.totalCost.plus(targetB!.totalCost).toString()).toBe('200.00000002');
    expect(stateFor(result.value, 'SRC_A')?.realizedGain.toString()).toBe('0');
    expect(stateFor(result.value, 'SRC_B')?.realizedGain.toString()).toBe('0');
  });

  it('conserves a partial conversion exactly at an eighth-decimal half boundary', () => {
    // 2 shares cost 1.00000001. Half the mathematical average is
    // 0.500000005, so the planner stores 0.50000001 once on both legs.
    // Replaying that exact outgoing cost leaves 0.50000000 and the incoming
    // leg receives 0.50000001: the original 1.00000001 is conserved exactly.
    const group = '00000000-c0de-7000-8000-000000000016';
    const result = replayPositions([
      aTransaction()
        .buy()
        .of('SRC')
        .on('2026-01-01')
        .quantity('2')
        .price('0.5')
        .fees('0.00000001')
        .build(),
      aTransaction()
        .conversionOut(group, '0.50000001')
        .of('SRC')
        .on('2026-02-01')
        .quantity('1')
        .build(),
      aTransaction()
        .conversionIn('0.50000001', group)
        .of('DST')
        .on('2026-02-01')
        .quantity('1')
        .build(),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const source = stateFor(result.value, 'SRC');
    const target = stateFor(result.value, 'DST');
    expect(source?.totalCost.toString()).toBe('0.5');
    expect(target?.totalCost.toString()).toBe('0.50000001');
    expect(source!.totalCost.plus(target!.totalCost).toString()).toBe('1.00000001');
  });

  describe('#138 — a closing leg persisted at the column scale', () => {
    // 3 shares for 10,00 (3 × 3,33333333 + 0,00000001 fee): average 10 ÷ 3,
    // cut at Money's 40 significant digits. Selling 1 at 3,33333333…3 leaves
    //   2 shares / 6,666666666666666666666666666666666666667
    // which the column holds as 6,66666667 — 3,3 × 10⁻⁹ *more* than replay.
    // The planner persists a whole-position removal at that stored figure
    // (`resolveAssetConversion`), exactly as BIDI11's 2.412,999…998 became
    // 2.413,00000000 on the owner's ledger.
    const group = '00000000-c0de-7000-8000-000000000017';
    const history = () => [
      aTransaction()
        .buy()
        .of('SRC')
        .on('2026-01-01')
        .quantity('3')
        .price('3.33333333')
        .fees('0.00000001')
        .build(),
      aTransaction().sell().of('SRC').on('2026-01-02').quantity('1').price('4').build(),
    ];
    const closing = (costBasis: string) =>
      aTransaction()
        .conversionOut(group, costBasis)
        .of('SRC')
        .on('2026-02-01')
        .quantity('2')
        .build();

    it('closes the source when the leg exceeds the held cost by less than half a unit', () => {
      const before = replayPosition(history());
      expect(before.ok && before.value.totalCost.toString()).toBe(
        '6.666666666666666666666666666666666666667',
      );
      const result = replayPositions([
        ...history(),
        closing('6.66666667'),
        aTransaction()
          .conversionIn('6.66666667', group)
          .of('DST')
          .on('2026-02-01')
          .quantity('1')
          .build(),
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok || !before.ok) return;
      const source = stateFor(result.value, 'SRC');
      const target = stateFor(result.value, 'DST');
      expect(source?.quantity.toString()).toBe('0');
      expect(source?.totalCost.toString()).toBe('0');
      // The conversion realises nothing: the gain is the sale's alone.
      expect(source?.realizedGain.toString()).toBe(before.value.realizedGain.toString());
      expect(target?.totalCost.toString()).toBe('6.66666667');
    });

    it('refuses a leg exceeding the held cost by half a unit or more', () => {
      // 6,66666668 − 6,666…667 = 1,33 × 10⁻⁸: a storage unit, not a rounding.
      const result = replayPosition([...history(), closing('6.66666668')]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
    });
  });

  it('applies a backdated same-day conversion before a split and trade', () => {
    // Existing target before the event: 10 @ 20,00 = 200,00.
    // Same day canonical order, regardless of insertion/arrival:
    //   conversion_in 50 / 1.000,00 => 60 / 1.200,00 / 20,00
    //   split ×2                    => 120 / 1.200,00 / 10,00
    //   buy 20 @ 12,00               => 140 / 1.440,00
    //   average                      = 1.440 ÷ 140 = 10,28571428…
    // If the backdated conversion ran after the split, quantity would be 90,
    // a plausible but irreconcilable answer.
    const initial = aTransaction()
      .buy()
      .of('TARGET')
      .on('2026-01-05')
      .quantity('10')
      .price('20')
      .build();
    const buy = aTransaction()
      .buy()
      .of('TARGET')
      .on('2026-06-01')
      .quantity('20')
      .price('12')
      .build();
    const split = aTransaction().split().of('TARGET').on('2026-06-01').ratio('2').build();
    const conversion = aTransaction()
      .conversionIn('1000', '00000000-c0de-7000-8000-000000000014')
      .of('TARGET')
      .on('2026-06-01')
      .quantity('50')
      .build();

    const chronological: readonly Transaction[] = [initial, conversion, split, buy];
    const insertedBackdated: readonly Transaction[] = [initial, buy, split, conversion];
    const expected = replayPosition(chronological);
    const actual = replayPosition(insertedBackdated);
    expect(expected.ok).toBe(true);
    expect(actual.ok).toBe(true);
    if (!expected.ok || !actual.ok) return;
    expect(actual.value.quantity.toString()).toBe('140');
    expect(actual.value.totalCost.toString()).toBe('1440');
    expect(actual.value.averageCost.toDecimal().toFixed(8)).toBe('10.28571428');
    expect(actual.value.averageCost.toString()).toBe(expected.value.averageCost.toString());
    expect(actual.value.realizedGain.toString()).toBe('0');
  });

  it('BR-005-20c — applies a same-day transfer carry before conversion_out', () => {
    // The source custodian sends 100 shares carrying 1.000,00 to the
    // destination, then that destination participates in an asset conversion:
    //   transfer_in    100 @ 10,00 => 100 / 1.000,00
    //   conversion_out 100         =>   0 /     0,00, no realised gain
    // The conversion is built first to model the commit planner discovering
    // it before the transfer pair. Created-at order would fail it against an
    // empty lot; BR-005-20c's type rank must put the carry first.
    const conversion = aTransaction()
      .conversionOut('00000000-c0de-7000-8000-000000000015', '1000')
      .of('OLD3')
      .at('DESTINATION')
      .on('2026-06-01')
      .quantity('100')
      .build();
    const transfer = aTransaction()
      .transferIn()
      .of('OLD3')
      .at('DESTINATION')
      .on('2026-06-01')
      .quantity('100')
      .price('10')
      .build();

    const result = replayPosition([conversion, transfer]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quantity.toString()).toBe('0');
    expect(result.value.totalCost.toString()).toBe('0');
    expect(result.value.averageCost.toString()).toBe('0');
    expect(result.value.realizedGain.toString()).toBe('0');
  });
});
