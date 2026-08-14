import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { valueListed, type ListedValuationInputs } from './listed';
import { NeedsAttentionReason, ValuationMethod } from './ports';
import type { AssetClass, LatestQuote, PriceQuote } from './ports';

/**
 * SPEC-009 BR-009-01..04 — listed assets.
 *
 * The running example throughout: **100 PETR4 at an average cost of
 * R$ 32,15**, so a cost basis of R$ 3.215,00. Every expected figure below is
 * that basis against a stated price, worked out in the comment beside it.
 */

const PETR4 = AssetId.of('0000000a-0009-7000-8000-000000000010');
const d = (value: string): BusinessDate => BusinessDate.of(value);
const to8 = (value: Money): string => value.toDecimal().toFixed(8);

function close(date: string, price: string): PriceQuote {
  return { assetId: PETR4, date: d(date), close: Money.fromString(price), source: 'test' };
}

function latest(price: string, quotedAt: string): LatestQuote {
  return {
    assetId: PETR4,
    price: Money.fromString(price),
    quotedAt: new Date(quotedAt),
    fetchedAt: new Date(quotedAt),
    source: 'test',
  };
}

function inputs(overrides: Partial<ListedValuationInputs> = {}): ListedValuationInputs {
  return {
    assetId: PETR4,
    assetClass: 'stock',
    quantity: Quantity.fromString('100'),
    averageCost: Money.fromString('32.15'),
    asOf: d('2026-03-16'),
    mode: 'historical',
    prices: { close: null, latest: null },
    ...overrides,
  };
}

describe('BR-009-01/04 / AC-1, AC-4 — quantity × price, and the gain it implies', () => {
  it('values at the close and reconciles the unrealised gain to value − quantity × average cost', () => {
    // value      = 100 × 38,42 = 3.842,00
    // cost basis = 100 × 32,15 = 3.215,00
    // unrealised = 3.842,00 − 3.215,00 = 627,00
    const valued = valueListed(
      inputs({ prices: { close: close('2026-03-16', '38.42'), latest: null } }),
    );
    expect(to8(valued.value)).toBe('3842.00000000');
    expect(to8(valued.costBasis)).toBe('3215.00000000');
    expect(to8(valued.unrealizedGain)).toBe('627.00000000');
    // AC-4 restated as the identity itself, so the assertion cannot pass by
    // agreeing with a hardcoded number that drifted.
    expect(valued.unrealizedGain.equals(valued.value.minus(valued.costBasis))).toBe(true);
    expect(valued.method).toBe(ValuationMethod.LISTED_QUOTE);
    expect(valued.estimated).toBe(false);
    expect(valued.grossOfTaxes).toBe(false);
  });

  it('a loss is a negative unrealised gain, not a clamped zero', () => {
    // 100 × 28,00 = 2.800,00 against a 3.215,00 basis → −415,00
    const valued = valueListed(
      inputs({ prices: { close: close('2026-03-16', '28.00'), latest: null } }),
    );
    expect(to8(valued.unrealizedGain)).toBe('-415.00000000');
  });

  it('a fractional quantity multiplies exactly — ETF and FII holdings are not whole', () => {
    // 12,345678 × 101,37, checked as exact integers so no decimal slips:
    //   12.345.678 × 10.137
    //     = 12.345.678 × 10.000        = 123.456.780.000
    //     + 12.345.678 × 100           =   1.234.567.800
    //     + 12.345.678 × 37            =     456.790.086
    //     =                              125.148.137.886
    //   6 dp + 2 dp = 8 dp, so ÷ 10⁸ → **1.251,48137886**
    // Exact: no truncation is reached, which is the point — a float would
    // land a few ulps away and this assertion would catch it.
    const valued = valueListed(
      inputs({
        quantity: Quantity.fromString('12.345678'),
        averageCost: Money.fromString('0'),
        prices: { close: close('2026-03-16', '101.37'), latest: null },
      }),
    );
    expect(to8(valued.value)).toBe('1251.48137886');
  });

  it('a position closed to zero is worth zero without needing a price', () => {
    // TS-28's "zero quantity" branch. 0 × anything is 0, and the cost basis is
    // zero too (BR-007-07 resets a closed position), so the gain is zero —
    // not a spurious loss equal to the last known basis.
    const valued = valueListed(
      inputs({
        quantity: Quantity.zero(),
        averageCost: Money.zero(),
        prices: { close: close('2026-03-16', '38.42'), latest: null },
      }),
    );
    expect(valued.value.isZero()).toBe(true);
    expect(valued.unrealizedGain.isZero()).toBe(true);
  });
});

describe('BR-009-02 / AC-2 — a historical valuation never touches an intraday quote', () => {
  it('ignores the latest quote entirely in historical mode', () => {
    // The property that keeps a past chart point from moving depending on what
    // time of day the page was loaded. The intraday quote here is wildly
    // different from the close on purpose: if it leaked in, 4.500,00 would
    // appear instead of 3.842,00.
    const valued = valueListed(
      inputs({
        mode: 'historical',
        prices: {
          close: close('2026-03-16', '38.42'),
          latest: latest('45.00', '2026-03-16T18:00:00Z'),
        },
      }),
    );
    expect(to8(valued.value)).toBe('3842.00000000');
    expect(valued.priceDate).toBe('2026-03-16');
  });

  it('uses the latest quote in current mode', () => {
    // 100 × 45,00 = 4.500,00
    const valued = valueListed(
      inputs({
        mode: 'current',
        prices: {
          close: close('2026-03-16', '38.42'),
          latest: latest('45.00', '2026-03-16T18:00:00Z'),
        },
      }),
    );
    expect(to8(valued.value)).toBe('4500.00000000');
    expect(valued.carriedForward).toBe(false);
  });

  it('falls back to the close in current mode when no intraday quote exists yet', () => {
    // Normal before the session's first poll — not an error.
    const valued = valueListed(
      inputs({ mode: 'current', prices: { close: close('2026-03-16', '38.42'), latest: null } }),
    );
    expect(to8(valued.value)).toBe('3842.00000000');
    expect(valued.method).toBe(ValuationMethod.LISTED_QUOTE);
  });

  it('AR-29: the quote’s instant resolves to a São Paulo date, not a UTC one', () => {
    // 2026-03-17T01:30:00Z is 22:30 on **16** March in São Paulo (UTC−3, and
    // Brazil has observed no DST since 2019). Reading the UTC date would date
    // this quote to the 17th and report it as tomorrow's price.
    const valued = valueListed(
      inputs({
        asOf: d('2026-03-16'),
        mode: 'current',
        prices: { close: null, latest: latest('45.00', '2026-03-17T01:30:00Z') },
      }),
    );
    expect(valued.priceDate).toBe('2026-03-16');
    expect(valued.carriedForward).toBe(false);
  });

  it('a stale intraday quote is marked carried forward rather than passed off as today’s', () => {
    const valued = valueListed(
      inputs({
        asOf: d('2026-03-18'),
        mode: 'current',
        prices: { close: null, latest: latest('45.00', '2026-03-16T18:00:00Z') },
      }),
    );
    expect(valued.priceDate).toBe('2026-03-16');
    expect(valued.carriedForward).toBe(true);
  });
});

describe('BR-009-03 / AC-3 — a missing quote carries the last close forward, visibly', () => {
  it('marks a carried-forward close and reports the date it actually came from', () => {
    // Sunday 2026-03-22 has no close. Friday the 20th's is used, and the
    // position says so — silent carry-forward is how a delisted or suspended
    // asset quietly holds a stale value for months.
    const valued = valueListed(
      inputs({
        asOf: d('2026-03-22'),
        prices: { close: close('2026-03-20', '38.42'), latest: null },
      }),
    );
    expect(to8(valued.value)).toBe('3842.00000000');
    expect(valued.carriedForward).toBe(true);
    expect(valued.priceDate).toBe('2026-03-20');
    // Still an *observed* price, just an older one — so it is not an estimate.
    // Labelling a whole portfolio "estimated" every weekend would drain the
    // marker of the meaning BR-009-11 gives it.
    expect(valued.estimated).toBe(false);
    expect(valued.needsAttention).toBeNull();
  });

  it('a same-day close is not carried forward', () => {
    const valued = valueListed(
      inputs({
        asOf: d('2026-03-20'),
        prices: { close: close('2026-03-20', '38.42'), latest: null },
      }),
    );
    expect(valued.carriedForward).toBe(false);
  });
});

describe('DL-009-05 generalised — no price at all is valued at cost, flagged, never dropped', () => {
  it('returns the cost basis with a PRICE_UNAVAILABLE flag', () => {
    // Never zero and never omitted: omitting understates the portfolio with no
    // visible cause, which is the one failure a user cannot detect.
    const valued = valueListed(inputs({ prices: { close: null, latest: null } }));
    expect(to8(valued.value)).toBe('3215.00000000');
    expect(valued.value.isZero()).toBe(false);
    expect(valued.method).toBe(ValuationMethod.COST_FALLBACK);
    expect(valued.needsAttention).toBe(NeedsAttentionReason.PRICE_UNAVAILABLE);
    expect(valued.estimated).toBe(true);
    expect(valued.priceDate).toBeNull();
    expect(valued.carriedForward).toBe(false);
    expect(valued.unrealizedGain.isZero()).toBe(true);
    expect(valued.basis).toBeNull();
  });

  it('current mode with neither an intraday quote nor a close falls back too', () => {
    const valued = valueListed(inputs({ mode: 'current', prices: { close: null, latest: null } }));
    expect(valued.method).toBe(ValuationMethod.COST_FALLBACK);
  });
});

describe('BR-009-20 / AC-17 — no FX layer', () => {
  it('a BDR is valued in BRL exactly like any other listed asset', () => {
    // BDRs trade in BRL on B3, so there is no conversion step to get wrong.
    // The consequence — a BDR's BRL return blends the underlying's move with
    // USD/BRL — is disclosed by the product (DL-009-07), not corrected here.
    for (const assetClass of [
      'stock',
      'fii',
      'bdr',
      'etf',
    ] as const satisfies readonly AssetClass[]) {
      const valued = valueListed(
        inputs({ assetClass, prices: { close: close('2026-03-16', '38.42'), latest: null } }),
      );
      expect(to8(valued.value), assetClass).toBe('3842.00000000');
      expect(valued.assetClass, assetClass).toBe(assetClass);
      expect(valued.grossOfTaxes, assetClass).toBe(false);
    }
  });
});
