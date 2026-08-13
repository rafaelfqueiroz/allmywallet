import { beforeEach, describe, expect, it } from 'vitest';
import { Money, Quantity } from '@/core/shared/money';
import type { Transaction } from '@/core/ledger/transaction';
import {
  aTransaction,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import { applyAcquisition, applySale } from '@/core/positions/average-cost';
import { EMPTY_POSITION } from '@/core/positions/position-state';
import { replayPosition } from '@/core/positions/replay';
import { BusinessDate } from '@/core/shared/clock';

/**
 * TS-11 — precision tested **adversarially**: hundreds of transactions with
 * repeating decimals, asserting no drift. This is the test that catches a JS
 * `number` leaking into a money path, because the expected values below are
 * exact and a float is not.
 */
describe('TS-11 — precision under hundreds of transactions', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  it('sums 300 buys of a repeating price to an exactly round total', () => {
    // Each buy: 3 shares at 0,33333333 with 0,00000001 of fees.
    //   3 × 0,33333333 = 0,99999999
    //   + 0,00000001   = 1,00000000   ← exactly one real per buy
    // Over 300 buys:
    //   total    = 300 × 1,00000000 = 300,00
    //   quantity = 300 × 3          = 900
    //   average  = 300 ÷ 900        = 0,3333…  (repeating, never rounded)
    //
    // In IEEE-754 doubles this lands near 299,99999999999994. The assertion
    // below is exact, so a single float anywhere in the acquisition path fails
    // it.
    const transactions: Transaction[] = [];
    for (let i = 0; i < 300; i += 1) {
      transactions.push(
        aTransaction().buy().quantity('3').price('0.33333333').fees('0.00000001').build(),
      );
    }

    const result = replayPosition(transactions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.quantity.toString()).toBe('900');
    expect(result.value.totalCost.toString()).toBe('300');
    // 1 ÷ 3 truncated at Money's 40 significant digits: "0." then 40 threes.
    expect(result.value.averageCost.toString()).toBe(`0.${'3'.repeat(40)}`);
  });

  it('sums 500 alternating buys to an exact average', () => {
    // 250 buys of 10 @ 0,10 → 250 × 1,00 =   250,00
    // 250 buys of 10 @ 0,20 → 250 × 2,00 =   500,00
    //   total    =                            750,00
    //   quantity = 500 × 10                = 5.000
    //   average  = 750 ÷ 5.000             =     0,15
    //
    // 0,1 + 0,2 is the canonical float failure (0,30000000000000004); doing it
    // 500 times compounds it well past the eighth decimal place.
    const transactions: Transaction[] = [];
    for (let i = 0; i < 500; i += 1) {
      transactions.push(
        aTransaction()
          .buy()
          .quantity('10')
          .price(i % 2 === 0 ? '0.10' : '0.20')
          .build(),
      );
    }

    const result = replayPosition(transactions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.quantity.toString()).toBe('5000');
    expect(result.value.totalCost.toString()).toBe('750');
    expect(result.value.averageCost.toString()).toBe('0.15');
  });

  it('BR-007-03 — repeated sales never move a repeating average, not by one digit', () => {
    // Build an average that never terminates:
    //   Buy 3 @ 10,00 → total  30,00
    //   Buy 4 @ 15,00 → total  90,00 over 7 shares
    //   average = 90 ÷ 7 = 12,857142857142857142857142…  (repeating "857142")
    //
    // Truncated at twenty decimal places by hand: three full six-digit blocks
    // (857142 857142 857142 = 18 digits) plus "85" = 12,85714285714285714285
    const EXPECTED_AVERAGE = '12.85714285714285714285';

    const opened = applyAcquisition(
      applyAcquisition(EMPTY_POSITION, {
        quantity: Quantity.fromString('3'),
        unitPrice: Money.fromString('10.00'),
        fees: Money.zero(),
      }),
      {
        quantity: Quantity.fromString('4'),
        unitPrice: Money.fromString('15.00'),
        fees: Money.zero(),
      },
    );
    expect(opened.totalCost.toString()).toBe('90');
    expect(opened.averageCost.toDecimal().toFixed(20)).toBe(EXPECTED_AVERAGE);

    // Six sales of one share each. After every one the average must be *the
    // same number*, not a number that rounds to it — recomputing it from the
    // reduced total cost would land a truncation away each time, and six
    // truncations is how a figure starts disagreeing with a broker statement.
    let state = opened;
    for (let i = 0; i < 6; i += 1) {
      const sold = applySale(state, {
        quantity: Quantity.fromString('1'),
        unitPrice: Money.fromString('20.00'),
        fees: Money.zero(),
        date: BusinessDate.of('2026-03-15'),
      });
      expect(sold.ok).toBe(true);
      if (!sold.ok) return;
      state = sold.value;
      expect(state.averageCost.equals(opened.averageCost)).toBe(true);
      expect(state.averageCost.toDecimal().toFixed(20)).toBe(EXPECTED_AVERAGE);
    }

    expect(state.quantity.toString()).toBe('1');

    // The seventh sale closes the lot, and BR-007-07's reset annihilates the
    // ~1e-38 residue the truncated average left in total cost.
    const closed = applySale(state, {
      quantity: Quantity.fromString('1'),
      unitPrice: Money.fromString('20.00'),
      fees: Money.zero(),
      date: BusinessDate.of('2026-03-15'),
    });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.value.totalCost.toString()).toBe('0');
    expect(closed.value.averageCost.toString()).toBe('0');
    // (20,00 − 12,857142857142857142857…) × 1 × 7 sales.
    // Realised in full: 7 shares bought for 90,00, sold for 7 × 20,00 = 140,00
    //   → 140,00 − 90,00 = 50,00, to within the truncation the average carries.
    expect(closed.value.realizedGain.toDecimal().toFixed(8)).toBe('50.00000000');
  });

  it('holds an exact total across 400 interleaved buys and sells', () => {
    // 200 cycles of: buy 7 @ 3,00 (21,00), then sell 7 @ 5,00.
    // Every cycle opens and closes the lot, so BR-007-07 resets 200 times and
    // any residue that survived a reset would compound visibly.
    //   realized per cycle = (5,00 − 3,00) × 7 = 14,00
    //   after 200 cycles   = 200 × 14,00       = 2.800,00
    //   final position     = flat
    const transactions: Transaction[] = [];
    for (let cycle = 0; cycle < 200; cycle += 1) {
      transactions.push(
        aTransaction()
          .buy()
          .on(dateFromOrdinal(cycle * 2))
          .quantity('7')
          .price('3.00')
          .build(),
      );
      transactions.push(
        aTransaction()
          .sell()
          .on(dateFromOrdinal(cycle * 2 + 1))
          .quantity('7')
          .price('5.00')
          .build(),
      );
    }

    const result = replayPosition(transactions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.quantity.toString()).toBe('0');
    expect(result.value.totalCost.toString()).toBe('0');
    expect(result.value.averageCost.toString()).toBe('0');
    expect(result.value.realizedGain.toString()).toBe('2800');
  });
});

/** Distinct consecutive dates, so ordering is unambiguous across 400 rows. */
function dateFromOrdinal(ordinal: number): string {
  const start = Date.UTC(2026, 0, 1);
  const day = new Date(start + ordinal * 86_400_000);
  return day.toISOString().slice(0, 10);
}
