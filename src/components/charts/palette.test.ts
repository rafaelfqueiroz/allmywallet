import { describe, expect, it } from 'vitest';
import type { AssetClass } from '@/core/quotes/ports';
import {
  ASSET_CLASS_COLOR,
  CHART_SERIES_COLORS,
  assetClassColor,
  chartColorAt,
} from '@/components/charts/palette';

/**
 * The binding is the contract (DS-10). If someone reorders these, two reports
 * start disagreeing about what colour an FII is, and nothing else in the suite
 * would notice.
 */
const ALL_ASSET_CLASSES: readonly AssetClass[] = [
  'stock',
  'fii',
  'bdr',
  'etf',
  'tesouro_direto',
  'cdb',
  'lci',
  'lca',
];

describe('chart palette', () => {
  it('binds every asset class to a colour', () => {
    for (const assetClass of ALL_ASSET_CLASSES) {
      expect(assetClassColor(assetClass)).toMatch(/^var\(--chart-[1-8]\)$/);
    }
  });

  it('gives each asset class a distinct slot — no two share a colour', () => {
    const assigned = ALL_ASSET_CLASSES.map(assetClassColor);
    expect(new Set(assigned).size).toBe(ALL_ASSET_CLASSES.length);
  });

  it('covers exactly the eight asset classes, with nothing left over', () => {
    expect(Object.keys(ASSET_CLASS_COLOR).sort()).toEqual([...ALL_ASSET_CLASSES].sort());
    expect(CHART_SERIES_COLORS).toHaveLength(8);
  });

  it('uses theme tokens, never literal colours — --chart-8 flips per theme', () => {
    for (const colour of CHART_SERIES_COLORS) {
      expect(colour.startsWith('var(--chart-')).toBe(true);
    }
  });

  it('wraps past the eighth slot rather than returning undefined (DS-11)', () => {
    expect(chartColorAt(0)).toBe(CHART_SERIES_COLORS[0]);
    expect(chartColorAt(8)).toBe(CHART_SERIES_COLORS[0]);
    expect(chartColorAt(11)).toBe(CHART_SERIES_COLORS[3]);
  });
});
