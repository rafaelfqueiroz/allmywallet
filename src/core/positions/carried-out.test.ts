import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import type { AssetIdentity } from '@/core/ledger/ports';
import type { Transaction } from '@/core/ledger/transaction';
import {
  aTransaction,
  assetIdFor,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import { amortizationTermsOf } from '@/core/positions/amortization';
import { costsCarriedOut } from '@/core/positions/carried-out';
import { PositionErrorCode } from '@/core/positions/errors';
import type { ReplayOptions } from '@/core/positions/replay';

/**
 * SPEC-013 BR-013-08 (amended 2026-09-29) / DL-013-08 — the cost a
 * `transfer_out` carries away from its source position: quantity ×
 * round₈(*preço médio* immediately before the debit). Every expected value is
 * worked by hand in the comment above it (TS-05).
 */

beforeEach(() => {
  resetTransactionSequence();
});

/** The cost carried out by `debit`, as the plain decimal string. */
function carried(
  ledger: readonly Transaction[],
  debit: Transaction,
  options: ReplayOptions = {},
): string | undefined {
  const result = costsCarriedOut(ledger, options);
  if (!result.ok) throw new Error(`expected costs, got ${result.error.code}`);
  return result.value.get(debit.id)?.toString();
}

function failure(ledger: readonly Transaction[], options: ReplayOptions = {}): string {
  const result = costsCarriedOut(ledger, options);
  if (result.ok) throw new Error('expected the fold to fail');
  return result.error.code;
}

describe('costsCarriedOut — the source preço médio × quantity', () => {
  it('a terminating average carries exactly the cost the debit removes', () => {
    //   buy 100 @ 32,15            → total 3.215,00, average 32,15
    //   transfer_out 100 (no price) → carries 100 × 32,15 = 3.215,00
    const debit = aTransaction()
      .transferOut()
      .at('Clear')
      .on('2026-03-10')
      .quantity('100')
      .price('0')
      .build();
    const ledger = [
      aTransaction().buy().at('Clear').on('2026-03-02').quantity('100').price('32.15').build(),
      debit,
    ];
    expect(carried(ledger, debit)).toBe('3215');
  });

  it('a repeating average carries at the scale the paired credit stores it (7 × 18,99428571)', () => {
    //   buy 7 @ 18,99 + 0,03 fees  → total 132,93 + 0,03 = 132,96
    //   average = 132,96 ÷ 7       = 18,994285714285714…
    //   round₈ (half-up; 9th digit 4) = 18,99428571
    //   carried = 7 × 18,99428571  = 132,95999997
    // The unrounded removal would be 132,96 — a 0,00000003 residual against a
    // credit carrying 18,99428571, which SPEC-005's withCarriedCost stores.
    const debit = aTransaction()
      .transferOut()
      .at('Clear')
      .on('2026-03-10')
      .quantity('7')
      .price('0')
      .build();
    const ledger = [
      aTransaction()
        .buy()
        .at('Clear')
        .on('2026-03-02')
        .quantity('7')
        .price('18.99')
        .fees('0.03')
        .build(),
      debit,
    ];
    expect(carried(ledger, debit)).toBe('132.95999997');
  });

  it('round₈ is half-up, as NUMERIC(20,8) is: 2,00 ÷ 3 carries 2,00000001', () => {
    //   buy 3 @ 0,66 + 0,02 fees   → total 1,98 + 0,02 = 2,00
    //   average = 2,00 ÷ 3         = 0,666666666…
    //   round₈ (9th digit 6, up)   = 0,66666667
    //   carried = 3 × 0,66666667   = 2,00000001
    const debit = aTransaction()
      .transferOut()
      .at('Clear')
      .on('2026-03-10')
      .quantity('3')
      .price('0')
      .build();
    const ledger = [
      aTransaction()
        .buy()
        .at('Clear')
        .on('2026-03-02')
        .quantity('3')
        .price('0.66')
        .fees('0.02')
        .build(),
      debit,
    ];
    expect(carried(ledger, debit)).toBe('2.00000001');
  });

  it('an average terminating within eight places is carried unchanged (128 × 11,42046875)', () => {
    //   buy 128 @ 11,42 + 0,06 fees → total 1.461,76 + 0,06 = 1.461,82
    //   average = 1.461,82 ÷ 128    = 11,42046875 (128 = 2⁷, so it terminates)
    //   carried = 128 × 11,42046875 = 1.461,82
    const debit = aTransaction()
      .transferOut()
      .at('Clear')
      .on('2026-03-10')
      .quantity('128')
      .price('0')
      .build();
    const ledger = [
      aTransaction()
        .buy()
        .at('Clear')
        .on('2026-03-02')
        .quantity('128')
        .price('11.42')
        .fees('0.06')
        .build(),
      debit,
    ];
    expect(carried(ledger, debit)).toBe('1461.82');
  });

  it('a sale before the debit leaves the average it carries untouched (455 × 22,1382625)', () => {
    //   buy 800 @ 22,13 + 6,61 fees → total 17.704,00 + 6,61 = 17.710,61
    //   average = 17.710,61 ÷ 800   = 22,1382625
    //   sell 345                    → 455 left, average 22,1382625 (BR-007-03)
    //   carried = 455 × 22,13826250 = 8.855,305 + 1.217,6044375 = 10.072,9094375
    const debit = aTransaction()
      .transferOut()
      .at('Clear')
      .on('2026-03-10')
      .quantity('455')
      .price('0')
      .build();
    const ledger = [
      aTransaction()
        .buy()
        .at('Clear')
        .on('2026-03-02')
        .quantity('800')
        .price('22.13')
        .fees('6.61')
        .build(),
      aTransaction().sell().at('Clear').on('2026-03-05').quantity('345').price('25').build(),
      debit,
    ];
    expect(carried(ledger, debit)).toBe('10072.9094375');
  });

  it('partial debits each carry the same average', () => {
    //   buy 10 @ 3,00 + 1,00 fee → total 31,00, average 3,10
    //   debit 4 → 4 × 3,10 = 12,40; 6 left, average 3,10 (a withdrawal keeps it)
    //   debit 6 → 6 × 3,10 = 18,60; 12,40 + 18,60 = 31,00, the whole cost
    const first = aTransaction()
      .transferOut()
      .at('Clear')
      .on('2026-03-10')
      .quantity('4')
      .price('0')
      .build();
    const second = aTransaction()
      .transferOut()
      .at('Clear')
      .on('2026-03-11')
      .quantity('6')
      .price('0')
      .build();
    const ledger = [
      aTransaction().buy().at('Clear').on('2026-03-02').quantity('10').price('3').fees('1').build(),
      first,
      second,
    ];
    expect(carried(ledger, first)).toBe('12.4');
    expect(carried(ledger, second)).toBe('18.6');
  });

  it('BR-007-15: a same-day buy enters the average before the debit carries it, whatever the arrival order', () => {
    //   2026-03-02  buy 100 @ 10,00 → total 1.000,00
    //   2026-03-10  debit 50, recorded *before* the day's buy
    //   2026-03-10  buy 100 @ 12,00 → rank 3 applies before the debit's rank 6
    //     average = (1.000,00 + 1.200,00) ÷ 200 = 11,00
    //     carried = 50 × 11,00 = 550,00
    const debit = aTransaction()
      .transferOut()
      .at('Clear')
      .on('2026-03-10')
      .quantity('50')
      .price('0')
      .build();
    const ledger = [
      debit,
      aTransaction().buy().at('Clear').on('2026-03-10').quantity('100').price('12').build(),
      aTransaction().buy().at('Clear').on('2026-03-02').quantity('100').price('10').build(),
    ];
    expect(carried(ledger, debit)).toBe('550');
  });

  it('BR-007-07: a lot closed to zero resets — a later debit carries only the new lot', () => {
    //   buy 10 @ 5,00, sell 10 → closed, cost reset to zero
    //   buy 10 @ 7,00           → new lot, average 7,00 (not a blend with 5,00)
    //   carried = 10 × 7,00 = 70,00
    const debit = aTransaction()
      .transferOut()
      .at('Clear')
      .on('2026-03-20')
      .quantity('10')
      .price('0')
      .build();
    const ledger = [
      aTransaction().buy().at('Clear').on('2026-03-02').quantity('10').price('5').build(),
      aTransaction().sell().at('Clear').on('2026-03-05').quantity('10').price('6').build(),
      aTransaction().buy().at('Clear').on('2026-03-10').quantity('10').price('7').build(),
      debit,
    ];
    expect(carried(ledger, debit)).toBe('70');
  });

  it('BR-007-08: each debit reads its own institution’s average, never the aggregate', () => {
    //   Clear 100 @ 10,00, XP 100 @ 20,00 (aggregate average would be 15,00)
    //   debit 100 at XP    → 100 × 20,00 = 2.000,00
    //   debit 50 at Clear  →  50 × 10,00 =   500,00
    const atXp = aTransaction()
      .transferOut()
      .at('XP')
      .on('2026-03-10')
      .quantity('100')
      .price('0')
      .build();
    const atClear = aTransaction()
      .transferOut()
      .at('Clear')
      .on('2026-03-10')
      .quantity('50')
      .price('0')
      .build();
    const ledger = [
      aTransaction().buy().at('Clear').on('2026-03-02').quantity('100').price('10').build(),
      aTransaction().buy().at('XP').on('2026-03-02').quantity('100').price('20').build(),
      atXp,
      atClear,
    ];
    expect(carried(ledger, atXp)).toBe('2000');
    expect(carried(ledger, atClear)).toBe('500');
  });

  it('#135: a same-position round trip carries back exactly what its credit brought in', () => {
    //   2026-03-02  buy 3 @ 3,33 + 0,01 fee → total 10,00, average 3,333333333…
    //   2026-03-10  credit 3 at Clear carrying round₈(3,3333…) = 3,33333333
    //               (rank 0, applies first) → 6 shares, total 19,99999999
    //               A′ = 19,99999999 ÷ 6 = 3,3333333316666…
    //   2026-03-10  debit 3 at Clear (rank 6)
    //               carried = 3 × round₈(A′) = 3 × 3,33333333 = 9,99999999
    //   — the credit's own 3 × 3,33333333, so the pair nets to zero.
    const debit = aTransaction()
      .transferOut()
      .at('Clear')
      .on('2026-03-10')
      .quantity('3')
      .price('0')
      .build();
    const ledger = [
      aTransaction()
        .buy()
        .at('Clear')
        .on('2026-03-02')
        .quantity('3')
        .price('3.33')
        .fees('0.01')
        .build(),
      aTransaction()
        .transferIn()
        .at('Clear')
        .on('2026-03-10')
        .quantity('3')
        .price('3.33333333')
        .build(),
      debit,
    ];
    expect(carried(ledger, debit)).toBe('9.99999999');
  });

  it('BR-007-05c: an amortization before the debit lowers the cost it carries', () => {
    //   buy 100 VIVT3 @ 10,00            → total 1.000,00
    //   amortization 100 × 1,00 = 100,00 → listed asset, all principal: total 900,00
    //   debit 100 → 100 × 9,00 = 900,00
    const identity: AssetIdentity = {
      assetId: assetIdFor('VIVT3'),
      code: 'VIVT3',
      assetClass: 'stock',
    };
    const debit = aTransaction()
      .transferOut()
      .of('VIVT3')
      .at('Clear')
      .on('2026-03-10')
      .quantity('100')
      .price('0')
      .build();
    const ledger = [
      aTransaction()
        .buy()
        .of('VIVT3')
        .at('Clear')
        .on('2026-03-02')
        .quantity('100')
        .price('10')
        .build(),
      aTransaction()
        .amortization()
        .of('VIVT3')
        .at('Clear')
        .on('2026-03-05')
        .quantity('100')
        .price('1')
        .build(),
      debit,
    ];
    expect(carried(ledger, debit, { amortization: amortizationTermsOf([identity]) })).toBe('900');
    // Without the terms the fold cannot say what the amortization returned, so
    // it fails rather than carry a guessed cost.
    expect(failure(ledger)).toBe(PositionErrorCode.AMORTIZATION_TERMS_UNKNOWN);
  });
});

describe('costsCarriedOut — what cannot be valued is not valued as zero', () => {
  it('a debit of more than was held fails, naming the shortfall', () => {
    const ledger = [
      aTransaction().buy().at('Clear').on('2026-03-02').quantity('10').price('10').build(),
      aTransaction().transferOut().at('Clear').on('2026-03-10').quantity('11').price('0').build(),
    ];
    expect(failure(ledger)).toBe(PositionErrorCode.INSUFFICIENT_QUANTITY);
  });

  it('an unreplayable row before the debit fails the debit too', () => {
    const ledger = [
      aTransaction().buy().at('Clear').on('2026-03-02').quantity('10').price('10').build(),
      aTransaction().sell().at('Clear').on('2026-03-05').quantity('20').price('10').build(),
      aTransaction().transferOut().at('Clear').on('2026-03-10').quantity('5').price('0').build(),
    ];
    expect(failure(ledger)).toBe(PositionErrorCode.INSUFFICIENT_QUANTITY);
  });

  it('a failure after the last debit, or in a position with no debit, is not this fold’s to report', () => {
    //   buy 10 @ 4,00, debit 5 → 5 × 4,00 = 20,00; the oversell after it, and
    //   the oversold XP position with no debit at all, change nothing here.
    const debit = aTransaction()
      .transferOut()
      .at('Clear')
      .on('2026-03-10')
      .quantity('5')
      .price('0')
      .build();
    const ledger = [
      aTransaction().buy().at('Clear').on('2026-03-02').quantity('10').price('4').build(),
      debit,
      aTransaction().sell().at('Clear').on('2026-03-12').quantity('50').price('4').build(),
      aTransaction().sell().at('XP').on('2026-03-02').quantity('1').price('4').build(),
    ];
    expect(carried(ledger, debit)).toBe('20');
  });
});

describe('costsCarriedOut — which rows participate', () => {
  it('BR-006-03 / BR-007-14: only active debits on or before asOf are valued', () => {
    const buy = aTransaction()
      .buy()
      .at('Clear')
      .on('2026-03-02')
      .quantity('10')
      .price('10')
      .build();
    const onAsOf = aTransaction()
      .transferOut()
      .at('Clear')
      .on('2026-03-10')
      .quantity('2')
      .price('0')
      .build();
    const later = aTransaction()
      .transferOut()
      .at('Clear')
      .on('2026-03-11')
      .quantity('2')
      .price('0')
      .build();
    const unclassified = aTransaction()
      .transferOut()
      .at('Clear')
      .on('2026-03-09')
      .quantity('2')
      .price('0')
      .status('unclassified')
      .build();
    const result = costsCarriedOut([buy, onAsOf, later, unclassified], {
      asOf: BusinessDate.of('2026-03-10'),
    });
    if (!result.ok) throw new Error(result.error.code);
    // 2 × 10,00 = 20,00 for the one debit in scope; the other two are absent.
    expect([...result.value.entries()].map(([id, cost]) => [id, cost.toString()])).toEqual([
      [onAsOf.id, '20'],
    ]);
  });

  it('a ledger with no debit carries nothing', () => {
    const result = costsCarriedOut([
      aTransaction().buy().at('Clear').on('2026-03-02').quantity('10').price('10').build(),
    ]);
    expect(result.ok && result.value.size).toBe(0);
  });
});
