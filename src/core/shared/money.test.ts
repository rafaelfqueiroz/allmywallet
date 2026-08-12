import { describe, expect, it } from 'vitest';
import { Money, Quantity, sumMoney, sumQuantity } from '@/core/shared/money';

/**
 * TS-04: every expected value here is computed by hand, not taken from the
 * implementation's own output. TS-11: the drift tests are the ones that catch a
 * `number` leaking into a money path — the failure that is invisible in a single
 * trade and fatal across ten years of them.
 */
describe('Money', () => {
  it('adds without floating-point error', () => {
    // The canonical float failure: 0.1 + 0.2 === 0.30000000000000004
    const result = Money.fromString('0.1').plus(Money.fromString('0.2'));
    expect(result.toString()).toBe('0.3');
  });

  it('rejects anything that is not a plain decimal literal', () => {
    expect(() => Money.fromString('1e5')).toThrow(TypeError);
    expect(() => Money.fromString('R$ 10,00')).toThrow(TypeError);
    expect(() => Money.fromString('')).toThrow(TypeError);
    expect(() => Money.fromString('abc')).toThrow(TypeError);
  });

  it('accepts a negative amount — a sale proceeds net of costs can be negative', () => {
    expect(Money.fromString('-12.34').isNegative()).toBe(true);
    expect(Money.fromString('-0').isNegative()).toBe(false);
  });

  it('derives preço médio from total and quantity', () => {
    // 100 × 25.50 = 2550.00
    //  50 × 31.20 = 1560.00
    // total 4110.00 over 150 shares = 27.40 exactly
    const total = Money.fromString('25.50')
      .times(Quantity.fromString('100'))
      .plus(Money.fromString('31.20').times(Quantity.fromString('50')));
    expect(total.toString()).toBe('4110');

    const average = total.dividedBy(Quantity.fromString('150'));
    expect(average.toString()).toBe('27.4');
  });

  it('never emits exponential notation — these strings go into NUMERIC columns', () => {
    // A tiny per-unit figure is exactly what a NUMERIC(20,8) column is for, and
    // `1e-8` is not a value every consumer of the string would parse.
    const tiny = Money.fromString('1').dividedBy(Quantity.fromString('100000000'));
    expect(tiny.toString()).toBe('0.00000001');
    expect(tiny.toString()).not.toContain('e');
  });

  it('refuses division by zero rather than yielding Infinity', () => {
    expect(() => Money.fromString('10').dividedBy(Quantity.zero())).toThrow(RangeError);
  });

  it('does not drift over ten thousand additions of a repeating-in-binary value', () => {
    // TS-11. 0.1 has no exact binary representation; summed 10,000 times as a
    // float this lands on 999.9999999999906, not 1000.
    let total = Money.zero();
    for (let i = 0; i < 10_000; i += 1) {
      total = total.plus(Money.fromString('0.1'));
    }
    expect(total.toString()).toBe('1000');
  });

  it('does not drift when a third is multiplied back out', () => {
    // 1000 ÷ 7 × 7 must not become 999.9999999999999. Division truncates at 40
    // significant digits, so the product differs from 1000 far below the 8th
    // decimal place that is actually persisted.
    const third = Money.fromString('1000').dividedBy(Quantity.fromString('7'));
    const back = third.times(Quantity.fromString('7'));
    const drift = back.minus(Money.fromString('1000')).abs();
    expect(drift.comparedTo(Money.fromString('0.00000001'))).toBeLessThan(0);
  });

  it('sums an empty list to zero rather than undefined', () => {
    expect(sumMoney([]).toString()).toBe('0');
    expect(sumQuantity([]).toString()).toBe('0');
  });

  it('serialises to a string across the JSON boundary (AR-10)', () => {
    // The whole hazard: a Decimal reaching JSON.stringify comes back a float.
    const payload = JSON.stringify({ price: Money.fromString('123.45678901') });
    expect(payload).toBe('{"price":"123.45678901"}');
  });

  it('compares without converting to a number', () => {
    const a = Money.fromString('10.00000001');
    const b = Money.fromString('10.00000002');
    expect(a.comparedTo(b)).toBe(-1);
    expect(b.comparedTo(a)).toBe(1);
    expect(a.comparedTo(Money.fromString('10.00000001'))).toBe(0);
    expect(a.equals(Money.fromString('10.00000001'))).toBe(true);
  });

  it('is immutable — an operation returns a new instance (DV-06)', () => {
    const original = Money.fromString('100');
    const changed = original.plus(Money.fromString('50'));
    expect(original.toString()).toBe('100');
    expect(changed.toString()).toBe('150');
  });
});

describe('Quantity', () => {
  it('applies a split ratio exactly', () => {
    // 100 shares in a 1:4 desdobramento → 400 shares.
    expect(Quantity.fromString('100').times('4').toString()).toBe('400');
  });

  it('handles a fractional quota count', () => {
    // FII fractions and fractional lots are real; quantities are not integers.
    const held = Quantity.fromString('12.34567891');
    expect(held.plus(Quantity.fromString('0.00000009')).toString()).toBe('12.345679');
  });

  it('reports a closed position as zero, not as a tiny residue', () => {
    const closed = Quantity.fromString('300').minus(Quantity.fromString('300'));
    expect(closed.isZero()).toBe(true);
    expect(closed.isPositive()).toBe(false);
    expect(closed.isNegative()).toBe(false);
  });

  it('rejects a non-finite number through the escape hatch', () => {
    expect(() => Quantity.unsafeFromNumber(Number.NaN)).toThrow(TypeError);
    expect(() => Money.unsafeFromNumber(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('Money — the operations reports lean on', () => {
  it('negates a reversal without losing precision', () => {
    // A cancelled trade is booked as the negation of the original, so the two
    // must sum to exactly zero rather than to a residue.
    const original = Money.fromString('1234.56789012');
    expect(original.plus(original.negated()).isZero()).toBe(true);
    expect(original.negated().toString()).toBe('-1234.56789012');
  });

  it('takes an absolute value for magnitude comparisons', () => {
    expect(Money.fromString('-89.9').abs().toString()).toBe('89.9');
    expect(Money.fromString('89.9').abs().toString()).toBe('89.9');
  });

  it('classifies sign without a three-way branch at every call site', () => {
    const gain = Money.fromString('0.00000001');
    const loss = Money.fromString('-0.00000001');
    expect([gain.isPositive(), gain.isNegative(), gain.isZero()]).toEqual([true, false, false]);
    expect([loss.isPositive(), loss.isNegative(), loss.isZero()]).toEqual([false, true, false]);
    expect(Money.zero().isPositive()).toBe(false);
  });

  it('accepts a Decimal-shaped operand as well as a string', () => {
    const price = Money.fromString('10');
    expect(price.times(Money.fromString('3').toDecimal()).toString()).toBe('30');
    expect(price.dividedBy(Money.fromString('4').toDecimal()).toString()).toBe('2.5');
  });

  it('sums a portfolio without drift', () => {
    // Twelve holdings at prices that are individually exact but sum through a
    // repeating intermediate.
    const values = ['1234.56', '0.01', '999.999', '0.00000001', '77.7', '4321.1234'].map((v) =>
      Money.fromString(v),
    );
    // 1234.56 + 0.01 + 999.999 + 0.00000001 + 77.7 + 4321.1234 = 6633.39240001
    expect(sumMoney(values).toString()).toBe('6633.39240001');
  });

  it('builds a Quantity from a hand-written number in a fixture', () => {
    expect(Quantity.unsafeFromNumber(100).toString()).toBe('100');
    expect(Money.unsafeFromNumber(25.5).toString()).toBe('25.5');
  });
});

describe('Quantity — the operations the position engine leans on', () => {
  it('negates and takes sign', () => {
    const held = Quantity.fromString('300');
    expect(held.negated().toString()).toBe('-300');
    expect(held.negated().isNegative()).toBe(true);
    expect(held.isPositive()).toBe(true);
  });

  it('divides a total by a share count, and refuses zero', () => {
    expect(Quantity.fromString('400').dividedBy('4').toString()).toBe('100');
    expect(() => Quantity.fromString('400').dividedBy(Quantity.zero())).toThrow(RangeError);
  });

  it('orders holdings for comparison', () => {
    const smaller = Quantity.fromString('99.99999999');
    const larger = Quantity.fromString('100');
    expect(smaller.comparedTo(larger)).toBe(-1);
    expect(larger.comparedTo(smaller)).toBe(1);
    expect(larger.equals(Quantity.fromString('100'))).toBe(true);
  });

  it('sums share counts across institutions', () => {
    const lots = ['100', '250.5', '0.00000001'].map((q) => Quantity.fromString(q));
    expect(sumQuantity(lots).toString()).toBe('350.50000001');
  });

  it('serialises to a string across the JSON boundary (AR-10)', () => {
    expect(JSON.stringify({ held: Quantity.fromString('12.5') })).toBe('{"held":"12.5"}');
  });

  it('rejects a malformed literal', () => {
    expect(() => Quantity.fromString('1,5')).toThrow(TypeError);
    expect(() => Quantity.fromString('2e3')).toThrow(TypeError);
  });
});
