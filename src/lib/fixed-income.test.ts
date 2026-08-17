import { describe, expect, it } from 'vitest';
import type { AssetClass } from '@/core/quotes/ports';
import { hasFixedIncome } from '@/lib/fixed-income';

describe('hasFixedIncome — SPEC-009 BR-009-12 / AC-10', () => {
  it('is false for a portfolio of listed equities alone', () => {
    expect(hasFixedIncome(['stock', 'fii', 'bdr', 'etf'] as AssetClass[])).toBe(false);
  });

  it.each<AssetClass>(['tesouro_direto', 'cdb', 'lci', 'lca'])(
    'is true when %s is held, so the disclosure renders',
    (assetClass) => {
      expect(hasFixedIncome(['stock', assetClass])).toBe(true);
    },
  );

  it('includes Tesouro Direto, which the valuation-side fixed-income set excludes', async () => {
    // The two sets answer different questions and must be allowed to differ:
    // `FIXED_INCOME_CLASSES` names what is priced by accrual, and Tesouro is
    // marked to market. It is still fixed income for the tax disclosure, and
    // this test is what stops the two being merged "for consistency".
    const { FIXED_INCOME_CLASSES } = await import('@/core/valuation/holdings');
    expect(FIXED_INCOME_CLASSES.has('tesouro_direto')).toBe(false);
    expect(hasFixedIncome(['tesouro_direto'])).toBe(true);
  });

  it('is false for an empty view, so an empty report carries no disclosure', () => {
    expect(hasFixedIncome([])).toBe(false);
  });
});
