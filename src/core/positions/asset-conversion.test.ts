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

    it('accepts a leg exceeding the held cost by exactly half a unit', () => {
      // 2 shares for 10,00000001; 1 sold leaves 1 share / 5,000000005. The
      // planner stores the whole-position removal half-up: 5,00000001, which
      // is 0,5 × 10⁻⁸ over — the widest gap its own rounding can produce.
      const half = '00000000-c0de-7000-8000-000000000018';
      const result = replayPosition([
        aTransaction()
          .buy()
          .of('SRC')
          .on('2026-01-01')
          .quantity('2')
          .price('5')
          .fees('0.00000001')
          .build(),
        aTransaction().sell().of('SRC').on('2026-01-02').quantity('1').price('6').build(),
        aTransaction()
          .conversionOut(half, '5.00000001')
          .of('SRC')
          .on('2026-02-01')
          .quantity('1')
          .build(),
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.quantity.toString()).toBe('0');
      expect(result.value.totalCost.toString()).toBe('0');
    });

    it('leaves shares still held at zero cost, never a negative preço médio', () => {
      // 4 shares for 0,00000001; 2 sold leave 2 / 0,000000005. A leg taking
      // 1 share at 0,00000001 is 0,5 × 10⁻⁸ over what is held: the share that
      // remains keeps quantity 1 and cost 0 — not −0,000000005.
      const partial = '00000000-c0de-7000-8000-000000000019';
      const result = replayPosition([
        aTransaction()
          .buy()
          .of('SRC')
          .on('2026-01-01')
          .quantity('4')
          .price('0')
          .fees('0.00000001')
          .build(),
        aTransaction().sell().of('SRC').on('2026-01-02').quantity('2').price('1').build(),
        aTransaction()
          .conversionOut(partial, '0.00000001')
          .of('SRC')
          .on('2026-02-01')
          .quantity('1')
          .build(),
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.quantity.toString()).toBe('1');
      expect(result.value.totalCost.toString()).toBe('0');
      expect(result.value.averageCost.toString()).toBe('0');
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

  describe('#143 — a two-source conversion, a fraction and a rename, in sequence (TS-06)', () => {
    /**
     * Generated shape (DV-24): round numbers, hand-computed. A conversion
     * carries cost and never cash (BR-007-05b), so Σ in cost = Σ out cost.
     *
     *   SRCA11 buy 90 @ 100,00               → 90 / 9.000,00
     *   SRCB11 buy 70 @ 98,92 + 0,60 fees    → 70 / 6.925,00 (70 × 98,92 = 6.924,40)
     *   2025-10-06 in  83,89 + 75,36 TGT11   → 159,25 / 15.925,00, avg 100,00
     *     in cost = 9.000,00 + 6.925,00 = 15.925,00; 15.925 × 83,89 ÷ 159,25
     *     = 8.389,00, the rest 7.536,00
     *   2025-10-14 out SRCA11 90, cost 9.000,00 → 0 / 0, realised 0
     *   2025-10-14 out SRCB11 70, cost 6.925,00 → 0 / 0, realised 0
     *   2025-10-20 sell 0,25 TGT11 @ 59,43   → proceeds 14,8575, cost out
     *     0,25 × 100,00 = 25,00, realised −10,1425; 159 / 15.900,00, avg 100,00
     *   2025-10-27 out TGT11 159, cost 15.900,00 → 0 / 0
     *   2025-10-27 in  NEWT11 159 at 15.900,00   → 159 / 15.900,00, avg 100,00
     */
    const mergeGroup = '00000000-c0de-7000-8000-000000000051';
    const renameGroup = '00000000-c0de-7000-8000-000000000052';
    function chain(): Transaction[] {
      return [
        aTransaction().buy().of('SRCA11').on('2024-03-01').quantity('90').price('100').build(),
        aTransaction()
          .buy()
          .of('SRCB11')
          .on('2024-03-01')
          .quantity('70')
          .price('98.92')
          .fees('0.60')
          .build(),
        aTransaction()
          .conversionIn('8389', mergeGroup)
          .of('TGT11')
          .on('2025-10-06')
          .quantity('83.89')
          .build(),
        aTransaction()
          .conversionIn('7536', mergeGroup)
          .of('TGT11')
          .on('2025-10-06')
          .quantity('75.36')
          .build(),
        aTransaction()
          .conversionOut(mergeGroup, '9000')
          .of('SRCA11')
          .on('2025-10-14')
          .quantity('90')
          .build(),
        aTransaction()
          .conversionOut(mergeGroup, '6925')
          .of('SRCB11')
          .on('2025-10-14')
          .quantity('70')
          .build(),
        aTransaction().sell().of('TGT11').on('2025-10-20').quantity('0.25').price('59.43').build(),
        aTransaction()
          .conversionOut(renameGroup, '15900')
          .of('TGT11')
          .on('2025-10-27')
          .quantity('159')
          .build(),
        aTransaction()
          .conversionIn('15900', renameGroup)
          .of('NEWT11')
          .on('2025-10-27')
          .quantity('159')
          .build(),
      ];
    }

    it('closes both sources at zero cost with no realised gain', () => {
      const result = replayPositions(chain());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const code of ['SRCA11', 'SRCB11']) {
        const state = stateFor(result.value, code);
        expect(state?.quantity.toString(), code).toBe('0');
        expect(state?.totalCost.toString(), code).toBe('0');
        expect(state?.realizedGain.toString(), code).toBe('0');
      }
    });

    it('asserts the target at every step: arrival, fraction sale, rename', () => {
      const ledger = chain();
      const target = (upTo: string) =>
        replayPosition(
          ledger.filter((t) => t.assetId === assetIdFor('TGT11') && t.tradeDate <= upTo),
        );

      const arrived = target('2025-10-06');
      expect(arrived.ok && arrived.value.quantity.toString()).toBe('159.25');
      expect(arrived.ok && arrived.value.totalCost.toString()).toBe('15925');
      expect(arrived.ok && arrived.value.averageCost.toString()).toBe('100');

      const sold = target('2025-10-20');
      expect(sold.ok && sold.value.quantity.toString()).toBe('159');
      expect(sold.ok && sold.value.totalCost.toString()).toBe('15900');
      expect(sold.ok && sold.value.averageCost.toString()).toBe('100');
      // 0,25 × 59,43 = 14,8575 − 0,25 × 100,00 = −10,1425.
      expect(sold.ok && sold.value.realizedGain.toString()).toBe('-10.1425');

      const renamed = target('2025-10-27');
      expect(renamed.ok && renamed.value.quantity.toString()).toBe('0');
      expect(renamed.ok && renamed.value.totalCost.toString()).toBe('0');
      // The rename realises nothing further.
      expect(renamed.ok && renamed.value.realizedGain.toString()).toBe('-10.1425');

      const all = replayPositions(ledger);
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      const next = stateFor(all.value, 'NEWT11');
      expect(next?.quantity.toString()).toBe('159');
      expect(next?.totalCost.toString()).toBe('15900');
      expect(next?.averageCost.toString()).toBe('100');
      expect(next?.realizedGain.toString()).toBe('0');
    });

    it('removes exactly cost_basis on an out leg, never reading a price or fees on it', () => {
      // A conversion leg is never priced (BR-007-05b); replay must not depend on
      // that. 90 @ 100,00 = 9.000,00; out 40 carrying 4.000,00 with a stray
      // 999,00 price: 50 / 5.000,00 / 100,00 left, realised 0.
      const result = replayPosition([
        aTransaction().buy().of('SRCA11').quantity('90').price('100').build(),
        aTransaction()
          .conversionOut(mergeGroup, '4000')
          .of('SRCA11')
          .on('2026-02-01')
          .quantity('40')
          .price('999')
          .fees('3')
          .build(),
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.quantity.toString()).toBe('50');
      expect(result.value.totalCost.toString()).toBe('5000');
      expect(result.value.averageCost.toString()).toBe('100');
      expect(result.value.realizedGain.toString()).toBe('0');
    });
  });
});
