import { describe, expect, it } from 'vitest';
import { Money, Quantity } from '@/core/shared/money';
import {
  EMPTY_POSITION,
  makePosition,
  positionsEqual,
  serializePosition,
} from '@/core/positions/position-state';

describe('PositionState', () => {
  it('starts empty — no lot, no cost, nothing realized', () => {
    expect(EMPTY_POSITION.quantity.toString()).toBe('0');
    expect(EMPTY_POSITION.totalCost.toString()).toBe('0');
    expect(EMPTY_POSITION.averageCost.toString()).toBe('0');
    expect(EMPTY_POSITION.realizedGain.toString()).toBe('0');
  });

  it('derives the average as total cost ÷ quantity', () => {
    // 1.000,00 over 80 shares = 12,50. Hand-computed: 1000 ÷ 80 = 12,5.
    const state = makePosition(Quantity.fromString('80'), Money.fromString('1000'), Money.zero());
    expect(state.averageCost.toString()).toBe('12.5');
  });

  it('carries an explicit average instead of deriving one, when given', () => {
    // BR-007-03's mechanism: a sale hands the previous average forward rather
    // than recomputing it. 900 ÷ 100 would be 9; the carried value wins.
    const state = makePosition(
      Quantity.fromString('100'),
      Money.fromString('900'),
      Money.zero(),
      Money.fromString('9.87654321'),
    );
    expect(state.averageCost.toString()).toBe('9.87654321');
  });

  describe('BR-007-07 — a position closed to zero resets', () => {
    it('drops cost and average, and keeps realized gain', () => {
      // The residue is deliberate: a closing sale computes
      // `totalCost − average × quantity`, and a truncated average leaves a
      // sliver behind. It must not survive into the next lot.
      const state = makePosition(
        Quantity.zero(),
        Money.fromString('0.00000000000000000000000000000000000005'),
        Money.fromString('250'),
      );
      expect(state.quantity.toString()).toBe('0');
      expect(state.totalCost.toString()).toBe('0');
      expect(state.averageCost.toString()).toBe('0');
      // Realized gain is history, not an open lot — it survives the reset.
      expect(state.realizedGain.toString()).toBe('250');
    });

    it('ignores an explicit average when the position is flat', () => {
      const state = makePosition(
        Quantity.zero(),
        Money.fromString('5'),
        Money.zero(),
        Money.fromString('33.33'),
      );
      expect(state.averageCost.toString()).toBe('0');
    });
  });

  describe('positionsEqual — the comparison DM-4 rests on', () => {
    const base = makePosition(
      Quantity.fromString('10'),
      Money.fromString('100'),
      Money.fromString('5'),
    );

    it('compares decimal values, not object identity', () => {
      const same = makePosition(
        Quantity.fromString('10.00'),
        Money.fromString('100.000'),
        Money.fromString('5.0'),
      );
      expect(positionsEqual(base, same)).toBe(true);
    });

    it.each([
      [
        'quantity',
        makePosition(Quantity.fromString('11'), Money.fromString('100'), Money.fromString('5')),
      ],
      [
        'total cost',
        makePosition(Quantity.fromString('10'), Money.fromString('101'), Money.fromString('5')),
      ],
      [
        'realized gain',
        makePosition(Quantity.fromString('10'), Money.fromString('100'), Money.fromString('6')),
      ],
      [
        'average',
        makePosition(
          Quantity.fromString('10'),
          Money.fromString('100'),
          Money.fromString('5'),
          Money.fromString('9.99'),
        ),
      ],
    ])('detects a difference in %s', (_field, other) => {
      expect(positionsEqual(base, other)).toBe(false);
    });
  });

  it('AR-10 — serialises to plain decimal strings, never numbers', () => {
    const state = makePosition(
      Quantity.fromString('3'),
      Money.fromString('10'),
      Money.fromString('-1.5'),
    );
    const serialized = serializePosition(state);

    expect(serialized.quantity).toBe('3');
    expect(serialized.totalCost).toBe('10');
    expect(serialized.realizedGain).toBe('-1.5');
    // 10 ÷ 3 = 3,333… truncated at Money's 40 significant digits. Written out
    // by hand: "3." followed by 39 threes.
    expect(serialized.averageCost).toBe(`3.${'3'.repeat(39)}`);

    // The whole point of AR-10: a JSON round-trip must not turn any of these
    // into a float.
    for (const value of Object.values(serialized)) {
      expect(typeof value).toBe('string');
    }
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
  });
});
