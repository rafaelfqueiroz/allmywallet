import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import { applyAcquisition, applySale } from '@/core/positions/average-cost';
import {
  applyBonus,
  applyBonusFractionRemoval,
  applyShareRatioEvent,
  applySubscription,
} from '@/core/positions/corporate-events';
import { EMPTY_POSITION, type PositionState } from '@/core/positions/position-state';

const DATE = BusinessDate.of('2026-04-20');

/** 100 shares at 10,00 — total cost 1.000,00. The starting point for every case. */
const HOLDING: PositionState = applyAcquisition(EMPTY_POSITION, {
  quantity: Quantity.fromString('100'),
  unitPrice: Money.fromString('10.00'),
  fees: Money.zero(),
});

describe('SPEC-007 BR-007-04 — split and grupamento', () => {
  it('AC — a 1:2 split doubles quantity, halves average, leaves total cost unchanged', () => {
    // Before  100 shares, average 10,00, total 1.000,00
    // Split ×2  (desdobramento 1:2 — each 1 share becomes 2)
    // After   200 shares
    //         total   = 1.000,00  ← no money moved, so cost cannot change
    //         average = 1.000,00 ÷ 200 = 5,00
    const result = applyShareRatioEvent(HOLDING, Quantity.fromString('2'), DATE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quantity.toString()).toBe('200');
    expect(result.value.totalCost.toString()).toBe('1000');
    expect(result.value.averageCost.toString()).toBe('5');
  });

  it('AC — a grupamento does the inverse', () => {
    // Before  100 shares, average 10,00, total 1.000,00
    // Grupamento 10:1 — each 10 shares become 1 → ratio 0,1
    // After    10 shares
    //         total   = 1.000,00
    //         average = 1.000,00 ÷ 10 = 100,00
    const result = applyShareRatioEvent(HOLDING, Quantity.fromString('0.1'), DATE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quantity.toString()).toBe('10');
    expect(result.value.totalCost.toString()).toBe('1000');
    expect(result.value.averageCost.toString()).toBe('100');
  });

  it('handles a 1:10 split', () => {
    // 100 × 10 = 1.000 shares; 1.000,00 ÷ 1.000 = 1,00
    const result = applyShareRatioEvent(HOLDING, Quantity.fromString('10'), DATE);
    expect(result.ok && result.value.quantity.toString()).toBe('1000');
    expect(result.ok && result.value.averageCost.toString()).toBe('1');
  });

  it('leaves realized gain alone — a share-base event realises nothing', () => {
    const withGain: PositionState = { ...HOLDING, realizedGain: Money.fromString('42.5') };
    const result = applyShareRatioEvent(withGain, Quantity.fromString('2'), DATE);
    expect(result.ok && result.value.realizedGain.toString()).toBe('42.5');
  });

  it('is a no-op on a flat position — a corporate action on an unheld asset', () => {
    const result = applyShareRatioEvent(EMPTY_POSITION, Quantity.fromString('2'), DATE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quantity.toString()).toBe('0');
    expect(result.value.averageCost.toString()).toBe('0');
  });

  it.each([
    ['zero', '0'],
    ['negative', '-2'],
  ])('refuses a %s ratio rather than erasing or inverting the position', (_label, ratio) => {
    const result = applyShareRatioEvent(HOLDING, Quantity.fromString(ratio), DATE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_EVENT_RATIO');
    expect(result.error.context).toEqual({ ratio, date: '2026-04-20' });
  });
});

describe('SPEC-007 BR-007-05 — bonificação', () => {
  it('AC — with attributed value: quantity and total cost both rise', () => {
    // Before  100 shares, average 10,00, total 1.000,00
    // Bonificação: 25 shares, B3-attributed value 8,00 each
    //   total   = 1.000,00 + 25 × 8,00 = 1.000,00 + 200,00 = 1.200,00
    //   qty     = 125
    //   average = 1.200,00 ÷ 125 = 9,60
    const result = applyBonus(HOLDING, {
      quantity: Quantity.fromString('25'),
      unitPrice: Money.fromString('8.00'),
      fees: Money.zero(),
    });

    expect(result.quantity.toString()).toBe('125');
    expect(result.totalCost.toString()).toBe('1200');
    expect(result.averageCost.toString()).toBe('9.6');
  });

  it('AC — with zero attributed value: quantity rises, average falls proportionally', () => {
    // Bonificação: 25 shares, nothing attributed
    //   total   = 1.000,00      ← unchanged, the shares were free
    //   qty     = 125
    //   average = 1.000,00 ÷ 125 = 8,00
    //
    // Cross-check that "proportionally" means what it says:
    //   10,00 × (100 ÷ 125) = 10,00 × 0,8 = 8,00 ✓
    //
    // The mistake this catches is leaving the average at 10,00. That overstates
    // cost basis by 25% and understates the eventual realized gain by the same,
    // producing a figure that reconciles against nothing.
    const result = applyBonus(HOLDING, {
      quantity: Quantity.fromString('25'),
      unitPrice: Money.zero(),
      fees: Money.zero(),
    });

    expect(result.quantity.toString()).toBe('125');
    expect(result.totalCost.toString()).toBe('1000');
    expect(result.averageCost.toString()).toBe('8');
  });

  it('keeps full precision when the new average repeats (AR-09, no rounding)', () => {
    // The spec's own illustration: 10 bonus shares on 100 held.
    //   total   = 1.000,00 + 10 × 8,00 = 1.080,00
    //   qty     = 110
    //   average = 1.080,00 ÷ 110 = 108 ÷ 11 = 9,8181818181…  (repeating "81")
    //
    // Truncated — not rounded — at ten decimal places by hand: 9,8181818181
    const result = applyBonus(HOLDING, {
      quantity: Quantity.fromString('10'),
      unitPrice: Money.fromString('8.00'),
      fees: Money.zero(),
    });

    expect(result.quantity.toString()).toBe('110');
    expect(result.totalCost.toString()).toBe('1080');
    expect(result.averageCost.toDecimal().toFixed(10)).toBe('9.8181818181');
  });
});

describe('SPEC-007 BR-007-05a — fraction left by a bonificação', () => {
  /** 100 shares at 20,00 — total cost 2.000,00 — with 42,50 already realised. */
  const BEFORE: PositionState = {
    ...applyAcquisition(EMPTY_POSITION, {
      quantity: Quantity.fromString('100'),
      unitPrice: Money.fromString('20.00'),
      fees: Money.zero(),
    }),
    realizedGain: Money.fromString('42.50'),
  };

  /**
   * Bonificação of 5,2 shares, nothing attributed (BR-007-05):
   *   qty     = 100 + 5,2          = 105,2
   *   total   = 2.000,00           ← unchanged
   *   average = 2.000,00 ÷ 105,2   = 5.000 ÷ 263 = 19,01140684…
   *     long division: 5.000 − 263 × 19 = 3 → 30 (0), 300 (1 r37), 370 (1 r107),
   *     1.070 (4 r18), 180 (0), 1.800 (6 r222), 2.220 (8 r116), 1.160 (4 r108)
   */
  const BONUSED = applyBonus(BEFORE, {
    quantity: Quantity.fromString('5.2'),
    unitPrice: Money.zero(),
    fees: Money.zero(),
  });

  it('the bonificação leaves 105,2 shares at an unchanged 2.000,00', () => {
    expect(BONUSED.quantity.toString()).toBe('105.2');
    expect(BONUSED.totalCost.toString()).toBe('2000');
    expect(BONUSED.averageCost.toDecimal().toFixed(8)).toBe('19.01140684');
  });

  it('removing the 0,2 fraction keeps total cost and recomputes the average on 105', () => {
    // qty     = 105,2 − 0,2       = 105
    // total   = 2.000,00          ← unchanged (BR-007-05a)
    // average = 2.000,00 ÷ 105    = 400 ÷ 21 = 19,047619047619…  (repeating "047619")
    //   400 − 21 × 19 = 1 → 1 ÷ 21 = 0,047619 047619 …
    //   At Money's 40 significant digits, truncated: 2 integer digits + 38
    //   decimals = six "047619" groups (36) + "04".
    // realized = 42,50            ← unchanged, a fraction removal is not a sale
    const result = applyBonusFractionRemoval(BONUSED, Quantity.fromString('0.2'), DATE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quantity.toString()).toBe('105');
    expect(result.value.totalCost.toString()).toBe('2000');
    expect(result.value.averageCost.toString()).toBe('19.04761904761904761904761904761904761904');
    expect(result.value.realizedGain.toString()).toBe('42.5');
  });

  it('refuses removing more than held, with the same error a sale gets (BR-006-15)', () => {
    // 105,2 held, 105,3 requested — refused, never clamped to zero.
    const removal = applyBonusFractionRemoval(BONUSED, Quantity.fromString('105.3'), DATE);
    const sale = applySale(BONUSED, {
      quantity: Quantity.fromString('105.3'),
      unitPrice: Money.fromString('1.00'),
      fees: Money.zero(),
      date: DATE,
    });

    expect(removal.ok).toBe(false);
    if (removal.ok || sale.ok) throw new Error('both must be refused');
    expect(removal.error.code).toBe('INSUFFICIENT_QUANTITY');
    expect(removal.error.context).toEqual({
      held: '105.2',
      requested: '105.3',
      date: '2026-04-20',
    });
    expect(removal.error).toEqual(sale.error);
  });

  it('removing a fraction-only position closes it, resets the lot, realises nothing (BR-007-07)', () => {
    // A position of 0,2 at 15,00 each: total 0,2 × 15,00 = 3,00.
    // Removing 0,2 → qty 0. The 3,00 goes with the lot (reset), and realized
    // gain stays at 42,50 — #113 Decision log row 11, owner-confirmed.
    const fractionOnly: PositionState = {
      ...applyAcquisition(EMPTY_POSITION, {
        quantity: Quantity.fromString('0.2'),
        unitPrice: Money.fromString('15.00'),
        fees: Money.zero(),
      }),
      realizedGain: Money.fromString('42.50'),
    };
    expect(fractionOnly.totalCost.toString()).toBe('3');

    const result = applyBonusFractionRemoval(fractionOnly, Quantity.fromString('0.2'), DATE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quantity.toString()).toBe('0');
    expect(result.value.totalCost.toString()).toBe('0');
    expect(result.value.averageCost.toString()).toBe('0');
    expect(result.value.realizedGain.toString()).toBe('42.5');
  });
});

describe('SPEC-007 BR-007-06 — subscription', () => {
  it('AC — is treated as a buy at the subscription price', () => {
    // Before  100 shares, total 1.000,00
    // Subscription: 100 shares exercised at 6,00
    //   total   = 1.000,00 + 100 × 6,00 = 1.600,00
    //   qty     = 200
    //   average = 1.600,00 ÷ 200 = 8,00
    const input = {
      quantity: Quantity.fromString('100'),
      unitPrice: Money.fromString('6.00'),
      fees: Money.zero(),
    };
    const result = applySubscription(HOLDING, input);

    expect(result.quantity.toString()).toBe('200');
    expect(result.totalCost.toString()).toBe('1600');
    expect(result.averageCost.toString()).toBe('8');

    // "Treated as a buy" is a literal claim, so it is asserted literally.
    const asBuy = applyAcquisition(HOLDING, input);
    expect(result.averageCost.equals(asBuy.averageCost)).toBe(true);
    expect(result.totalCost.equals(asBuy.totalCost)).toBe(true);
  });

  it('capitalises subscription fees into the cost basis', () => {
    // 1.000,00 + 100 × 6,00 + 20,00 = 1.620,00 over 200 shares = 8,10
    const result = applySubscription(HOLDING, {
      quantity: Quantity.fromString('100'),
      unitPrice: Money.fromString('6.00'),
      fees: Money.fromString('20.00'),
    });
    expect(result.averageCost.toString()).toBe('8.1');
  });
});
