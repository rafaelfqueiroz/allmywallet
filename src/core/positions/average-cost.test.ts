import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import { applyAcquisition, applySale, applyWithdrawal } from '@/core/positions/average-cost';
import { EMPTY_POSITION, type PositionState } from '@/core/positions/position-state';

/**
 * TS-05: every rule in SPEC-007 §Average cost gets a **hand-computed**
 * expectation with the arithmetic written into the test. Nothing here asserts
 * on what the implementation happens to produce — the numbers below were
 * worked out on paper first, and if the code disagrees the code is wrong.
 */

const DATE = BusinessDate.of('2026-03-15');

function buy(state: PositionState, qty: string, price: string, fees = '0'): PositionState {
  return applyAcquisition(state, {
    quantity: Quantity.fromString(qty),
    unitPrice: Money.fromString(price),
    fees: Money.fromString(fees),
  });
}

describe('SPEC-007 BR-007-02 — buy: moving weighted average, fees included', () => {
  it('a single buy averages to price plus fees spread over the shares', () => {
    // 100 × 30,00 = 3.000,00, plus 5,00 of fees = 3.005,00
    // 3.005,00 ÷ 100 = 30,05
    const state = buy(EMPTY_POSITION, '100', '30.00', '5.00');

    expect(state.quantity.toString()).toBe('100');
    expect(state.totalCost.toString()).toBe('3005');
    expect(state.averageCost.toString()).toBe('30.05');
  });

  it('a second buy weights by quantity, not by price (AC: sequence of buys)', () => {
    // Step 1  100 @ 30,00 fees 5,00 → total 3.005,00, average 30,05
    // Step 2   50 @ 36,00 fees 4,00
    //            added  = 50 × 36,00 + 4,00 = 1.800,00 + 4,00 = 1.804,00
    //            total  = 3.005,00 + 1.804,00           = 4.809,00
    //            qty    = 100 + 50                      =   150
    //            average= 4.809,00 ÷ 150                =    32,06
    //
    // Deliberately NOT the mean of the two averages: (30,05 + 36,08) ÷ 2 =
    // 33,065. Weighting by quantity is the whole rule, and the wrong figure is
    // only 3% out — plausible enough to survive review, wrong enough to
    // misstate a tax return.
    const state = buy(buy(EMPTY_POSITION, '100', '30.00', '5.00'), '50', '36.00', '4.00');

    expect(state.quantity.toString()).toBe('150');
    expect(state.totalCost.toString()).toBe('4809');
    expect(state.averageCost.toString()).toBe('32.06');
  });

  it('AC — buy fees increase the average cost, by exactly fees ÷ quantity', () => {
    // 100 shares, 5,00 of fees → 5,00 ÷ 100 = 0,05 on the average.
    const withoutFees = buy(EMPTY_POSITION, '100', '30.00', '0');
    const withFees = buy(EMPTY_POSITION, '100', '30.00', '5.00');

    expect(withoutFees.averageCost.toString()).toBe('30');
    expect(withFees.averageCost.toString()).toBe('30.05');
    expect(withFees.averageCost.minus(withoutFees.averageCost).toString()).toBe('0.05');
  });

  it('buying into an empty position opens the lot', () => {
    const state = buy(EMPTY_POSITION, '10', '7.50');
    expect(state.totalCost.toString()).toBe('75');
    expect(state.averageCost.toString()).toBe('7.5');
    expect(state.realizedGain.toString()).toBe('0');
  });
});

describe('SPEC-007 BR-007-03 / BR-007-09 — sell', () => {
  // The position every case below starts from:
  //   100 @ 30,00 fees 5,00, then 50 @ 36,00 fees 4,00
  //   → 150 shares, total cost 4.809,00, average 32,06
  const holding = buy(buy(EMPTY_POSITION, '100', '30.00', '5.00'), '50', '36.00', '4.00');

  function sell(state: PositionState, qty: string, price: string, fees = '0') {
    return applySale(state, {
      quantity: Quantity.fromString(qty),
      unitPrice: Money.fromString(price),
      fees: Money.fromString(fees),
      date: DATE,
    });
  }

  it('AC — a sale leaves the average unchanged and reduces quantity correctly', () => {
    // Sell 40 @ 40,00, fees 3,50
    //   realized = (40,00 − 32,06) × 40 − 3,50
    //            =  7,94 × 40 − 3,50 = 317,60 − 3,50 = 314,10
    //   quantity = 150 − 40                          = 110
    //   total    = 4.809,00 − 32,06 × 40
    //            = 4.809,00 − 1.282,40               = 3.526,60
    //   average  =                                     32,06  ← unchanged
    //   check      3.526,60 ÷ 110                    =  32,06 ✓
    const result = sell(holding, '40', '40.00', '3.50');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quantity.toString()).toBe('110');
    expect(result.value.totalCost.toString()).toBe('3526.6');
    expect(result.value.averageCost.toString()).toBe('32.06');
    expect(result.value.realizedGain.toString()).toBe('314.1');
  });

  it('AC — sale fees reduce realized gain, by exactly the fee', () => {
    const free = sell(holding, '40', '40.00', '0');
    const charged = sell(holding, '40', '40.00', '3.50');

    expect(free.ok && free.value.realizedGain.toString()).toBe('317.6');
    expect(charged.ok && charged.value.realizedGain.toString()).toBe('314.1');
  });

  it('realises a loss as a negative figure, deepened by the fee', () => {
    // (28,00 − 32,06) × 40 − 3,50 = −4,06 × 40 − 3,50 = −162,40 − 3,50 = −165,90
    const result = sell(holding, '40', '28.00', '3.50');
    expect(result.ok && result.value.realizedGain.toString()).toBe('-165.9');
  });

  it('accumulates realized gain across successive sales', () => {
    // Sale 1: (40,00 − 32,06) × 40 = 317,60          → running 317,60
    // Sale 2: (35,00 − 32,06) × 10 =  2,94 × 10 = 29,40 → running 347,00
    const first = sell(holding, '40', '40.00');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = sell(first.value, '10', '35.00');

    expect(second.ok && second.value.realizedGain.toString()).toBe('347');
    // 150 − 40 − 10 = 100, and the average never moved.
    expect(second.ok && second.value.quantity.toString()).toBe('100');
    expect(second.ok && second.value.averageCost.toString()).toBe('32.06');
  });

  it('BR-007-11 — realized gain is not restated by a later purchase', () => {
    // Buy 100 @ 10,00            → total 1.000,00, average 10,00
    // Sell 50 @ 15,00            → realized (15 − 10) × 50 = 250,00
    //                              quantity 50, total 1.000,00 − 10 × 50 = 500,00
    // Buy 150 @ 20,00            → total 500,00 + 3.000,00 = 3.500,00
    //                              quantity 200, average 3.500,00 ÷ 200 = 17,50
    // The later buy raises the average going forward. It must not touch the
    // 250,00 already realised — that figure is on a tax return.
    const opened = buy(EMPTY_POSITION, '100', '10.00');
    const sold = sell(opened, '50', '15.00');
    expect(sold.ok).toBe(true);
    if (!sold.ok) return;
    expect(sold.value.realizedGain.toString()).toBe('250');

    const reloaded = buy(sold.value, '150', '20.00');
    expect(reloaded.averageCost.toString()).toBe('17.5');
    expect(reloaded.totalCost.toString()).toBe('3500');
    expect(reloaded.realizedGain.toString()).toBe('250');
  });

  describe('BR-006-15 — selling more than held is refused, never clamped', () => {
    it('names the held and requested quantities and the date (AR-37)', () => {
      const result = sell(holding, '151', '40.00');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
      expect(result.error.context).toEqual({
        held: '150',
        requested: '151',
        date: '2026-03-15',
      });
    });

    it('permits selling exactly the held quantity', () => {
      const result = sell(holding, '150', '40.00');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // BR-007-07: closed to zero, so the lot resets.
      expect(result.value.quantity.toString()).toBe('0');
      expect(result.value.totalCost.toString()).toBe('0');
      expect(result.value.averageCost.toString()).toBe('0');
      // (40,00 − 32,06) × 150 = 7,94 × 150 = 1.191,00
      expect(result.value.realizedGain.toString()).toBe('1191');
    });

    it('refuses any sale out of an empty position', () => {
      const result = sell(EMPTY_POSITION, '1', '10.00');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.context['held']).toBe('0');
    });
  });
});

describe('applyWithdrawal — shares leaving without a disposal', () => {
  const holding = buy(EMPTY_POSITION, '100', '10.00');

  it('reduces quantity at average cost and realises nothing', () => {
    // 100 @ 10,00 (total 1.000,00); withdraw 40.
    //   quantity = 60
    //   total    = 1.000,00 − 10,00 × 40 = 600,00
    //   average  = 10,00  ← unchanged
    //   realized = 0,00   ← a custody move is not a disposal
    const result = applyWithdrawal(holding, Quantity.fromString('40'), DATE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quantity.toString()).toBe('60');
    expect(result.value.totalCost.toString()).toBe('600');
    expect(result.value.averageCost.toString()).toBe('10');
    expect(result.value.realizedGain.toString()).toBe('0');
  });

  it('refuses to withdraw more than is held', () => {
    const result = applyWithdrawal(holding, Quantity.fromString('101'), DATE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
  });

  it('resets the lot when the withdrawal empties the position', () => {
    const result = applyWithdrawal(holding, Quantity.fromString('100'), DATE);
    expect(result.ok && result.value.averageCost.toString()).toBe('0');
    expect(result.ok && result.value.totalCost.toString()).toBe('0');
  });
});

describe('BR-007-07 — closing to zero then rebuying starts a fresh lot', () => {
  it('carries no residual cost from the closed lot, even from a repeating average', () => {
    // The reset is invisible with tidy numbers, because `totalCost − avg × qty`
    // lands exactly on zero. It only shows when the average repeats, so this
    // fixture is built to repeat:
    //
    //   Buy 3 @ 10,00  → total   30,00
    //   Buy 4 @ 15,00  → total   30,00 + 60,00 = 90,00 over 7 shares
    //                    average 90 ÷ 7 = 12,857142857142…  (never terminates)
    //   Sell all 7     → total = 90,00 − (truncated average) × 7
    //                          = 89,999…95, i.e. a residue of about 5 × 10⁻³⁸
    //
    // Without BR-007-07's reset that residue survives into the next lot, and
    // the re-entry's average comes out as 5,000000000000000000000000000000000000005
    // instead of 5,00 — a *preço médio* that matches no broker statement.
    const opened = buy(buy(EMPTY_POSITION, '3', '10.00'), '4', '15.00');
    expect(opened.totalCost.toString()).toBe('90');

    const closed = applySale(opened, {
      quantity: Quantity.fromString('7'),
      unitPrice: Money.fromString('20.00'),
      fees: Money.zero(),
      date: DATE,
    });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.value.quantity.toString()).toBe('0');
    expect(closed.value.totalCost.toString()).toBe('0');
    expect(closed.value.averageCost.toString()).toBe('0');

    const reopened = buy(closed.value, '10', '5.00');
    expect(reopened.quantity.toString()).toBe('10');
    expect(reopened.totalCost.toString()).toBe('50');
    expect(reopened.averageCost.toString()).toBe('5');
  });
});
