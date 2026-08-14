import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { valueTesouro, type TesouroValuationInputs } from './tesouro';
import { NeedsAttentionReason, ValuationMethod } from './ports';
import type { PriceQuote } from './ports';

/**
 * SPEC-009 BR-009-05/06, DL-009-04 — Tesouro Direto.
 *
 * Running example: **3,5 units of Tesouro IPCA+ 2035** at an average PU of
 * R$ 3.200,00, so a cost basis of R$ 11.200,00. The published prices are the
 * ones in `src/adapters/quotes/tesouro.test.ts`'s fixture, so the two halves
 * of BR-009-06 — which column is ingested, and what is done with it — are
 * exercised against the same numbers.
 */

const TITLE = AssetId.of('0000000a-0009-7000-8000-000000000020');
const d = (value: string): BusinessDate => BusinessDate.of(value);
const to8 = (value: Money): string => value.toDecimal().toFixed(8);

function quote(date: string, price: string): PriceQuote {
  return { assetId: TITLE, date: d(date), close: Money.fromString(price), source: 'tesouro' };
}

function inputs(overrides: Partial<TesouroValuationInputs> = {}): TesouroValuationInputs {
  return {
    assetId: TITLE,
    quantity: Quantity.fromString('3.5'),
    averageCost: Money.fromString('3200'),
    asOf: d('2026-03-16'),
    sellPrice: quote('2026-03-16', '3413.70'),
    ...overrides,
  };
}

describe('BR-009-05 / AC-5 — marked to market, and NOT flagged as an estimate', () => {
  it('values at the published price and carries no estimate marker', () => {
    // value      = 3,5 × 3.413,70 = 11.947,95
    //   3,5 × 3.413,70 = 3 × 3.413,70 + 0,5 × 3.413,70
    //                  = 10.241,10    +    1.706,85
    //                  = 11.947,95
    // cost basis = 3,5 × 3.200,00 = 11.200,00
    // unrealised =    11.947,95 − 11.200,00 = 747,95
    const valued = valueTesouro(inputs());
    expect(to8(valued.value)).toBe('11947.95000000');
    expect(to8(valued.costBasis)).toBe('11200.00000000');
    expect(to8(valued.unrealizedGain)).toBe('747.95000000');

    // AC-5, the assertion this file exists for: Tesouro Transparente publishes
    // a real observed price, so the figure is *not* an estimate. Only accrued
    // bank paper is (BR-009-11) — blending the two would misrepresent the
    // precision of both.
    expect(valued.estimated).toBe(false);
    expect(valued.method).toBe(ValuationMethod.TESOURO_SELL_PRICE);
    expect(valued.needsAttention).toBeNull();
    expect(valued.basis).toBeNull();
    expect(valued.assetClass).toBe('tesouro_direto');
  });

  it('BR-009-12 / AC-10: still declares itself gross of IR and IOF', () => {
    // Tesouro Direto is fixed income and is taxed at redemption. An observed
    // price is not a net-of-tax price, and v1 says so rather than implying it.
    expect(valueTesouro(inputs()).grossOfTaxes).toBe(true);
  });
});

describe('BR-009-06 / DL-009-04 — the sell price, not the buy price', () => {
  it('the spread is real money: the buy price would overstate the same holding', () => {
    // From the ingestion fixture for 16/03/2026, Tesouro IPCA+ 15/05/2035:
    //   PU Compra Manhã  3.415,00   ← what the investor pays to buy
    //   PU Venda  Manhã  3.413,70   ← what the investor receives on sale
    //
    // sell:  3,5 × 3.413,70 = 11.947,95
    // buy:   3,5 × 3.415,00 = 11.952,50
    // difference             =      4,55 — money the holder could not realise.
    //
    // Small on one title and in one direction every single day, across every
    // Tesouro position a user holds. That is why DL-009-04 picks a side rather
    // than treating the two as interchangeable.
    const atSell = valueTesouro(inputs({ sellPrice: quote('2026-03-16', '3413.70') }));
    const atBuy = valueTesouro(inputs({ sellPrice: quote('2026-03-16', '3415.00') }));
    expect(to8(atSell.value)).toBe('11947.95000000');
    expect(to8(atBuy.value)).toBe('11952.50000000');
    expect(to8(atBuy.value.minus(atSell.value))).toBe('4.55000000');
  });
});

describe('BR-009-03 — carry-forward is visible for Tesouro too', () => {
  it('a weekend valuation uses Friday’s price and says so', () => {
    // Tesouro Transparente publishes on business days only, so every Saturday
    // and Sunday is a carry-forward by construction.
    const valued = valueTesouro(
      inputs({ asOf: d('2026-03-21'), sellPrice: quote('2026-03-20', '3413.70') }),
    );
    expect(valued.carriedForward).toBe(true);
    expect(valued.priceDate).toBe('2026-03-20');
    // Still observed, still not an estimate.
    expect(valued.estimated).toBe(false);
  });

  it('a same-day price is not carried forward', () => {
    const valued = valueTesouro(inputs());
    expect(valued.carriedForward).toBe(false);
    expect(valued.priceDate).toBe('2026-03-16');
  });
});

describe('DL-009-05 — a title with no published price is valued at cost, flagged', () => {
  it('returns the cost basis rather than zero or nothing', () => {
    const valued = valueTesouro(inputs({ sellPrice: null }));
    expect(to8(valued.value)).toBe('11200.00000000');
    expect(valued.value.isZero()).toBe(false);
    expect(valued.method).toBe(ValuationMethod.COST_FALLBACK);
    expect(valued.needsAttention).toBe(NeedsAttentionReason.PRICE_UNAVAILABLE);
    expect(valued.estimated).toBe(true);
    expect(valued.grossOfTaxes).toBe(true);
    expect(valued.priceDate).toBeNull();
    expect(valued.carriedForward).toBe(false);
    expect(valued.unrealizedGain.isZero()).toBe(true);
  });
});
