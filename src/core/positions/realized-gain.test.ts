import { describe, expect, it } from 'vitest';
import { Money, Quantity } from '@/core/shared/money';
import { realizedGainOnSale } from '@/core/positions/realized-gain';

/**
 * SPEC-007 BR-007-09:
 * `realized gain = (sale price − average cost at sale date) × quantity − fees`
 */
describe('realizedGainOnSale', () => {
  it.each([
    {
      label: 'a gain',
      price: '40.00',
      average: '32.06',
      quantity: '40',
      fees: '3.50',
      // (40,00 − 32,06) × 40 − 3,50 = 7,94 × 40 − 3,50 = 317,60 − 3,50
      expected: '314.1',
    },
    {
      label: 'a loss, deepened by the fee',
      price: '28.00',
      average: '32.06',
      quantity: '40',
      fees: '3.50',
      // (28,00 − 32,06) × 40 − 3,50 = −4,06 × 40 − 3,50 = −162,40 − 3,50
      expected: '-165.9',
    },
    {
      label: 'a sale exactly at cost, which is a loss of the fee alone',
      price: '32.06',
      average: '32.06',
      quantity: '40',
      fees: '3.50',
      // 0 × 40 − 3,50
      expected: '-3.5',
    },
    {
      label: 'a fee-free sale',
      price: '15.00',
      average: '10.00',
      quantity: '50',
      fees: '0',
      // (15,00 − 10,00) × 50 = 250,00
      expected: '250',
    },
    {
      label: 'a fractional quantity, as a Tesouro Direto sale produces',
      price: '112.50',
      average: '100.00',
      quantity: '0.07',
      fees: '0',
      // (112,50 − 100,00) × 0,07 = 12,50 × 0,07 = 0,875
      expected: '0.875',
    },
  ])('computes $label', ({ price, average, quantity, fees, expected }) => {
    const gain = realizedGainOnSale({
      unitPrice: Money.fromString(price),
      averageCost: Money.fromString(average),
      quantity: Quantity.fromString(quantity),
      fees: Money.fromString(fees),
    });
    expect(gain.toString()).toBe(expected);
  });

  it('BR-007-10 — is average-cost based, not FIFO', () => {
    // Two lots: 100 @ 10,00 then 100 @ 20,00 → average 15,00 over 200 shares.
    // Selling 100 @ 25,00:
    //   average cost basis: (25,00 − 15,00) × 100 = 1.000,00   ← what we report
    //   FIFO basis        : (25,00 − 10,00) × 100 = 1.500,00   ← what we must NOT
    //
    // The two differ by 500,00 on a single trade. FIFO is the convention in
    // other jurisdictions; here it contradicts what the user must actually
    // declare (DL-007-02), so the distinction is asserted rather than assumed.
    const averageBasis = realizedGainOnSale({
      unitPrice: Money.fromString('25.00'),
      averageCost: Money.fromString('15.00'),
      quantity: Quantity.fromString('100'),
      fees: Money.zero(),
    });
    const fifoBasis = realizedGainOnSale({
      unitPrice: Money.fromString('25.00'),
      averageCost: Money.fromString('10.00'),
      quantity: Quantity.fromString('100'),
      fees: Money.zero(),
    });

    expect(averageBasis.toString()).toBe('1000');
    expect(fifoBasis.toString()).toBe('1500');
    expect(averageBasis.equals(fifoBasis)).toBe(false);
  });
});
