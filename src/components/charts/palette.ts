import type { AssetClass } from '@/core/quotes/ports';

/**
 * DS-10 / DL-04 — the eight Okabe–Ito slots, bound one-to-one and permanently
 * to the eight asset classes.
 *
 * The binding is the point, not the colours. A palette chosen per chart is how
 * the composition report shows FIIs in green and the performance report shows
 * them in orange, and a user reconciling two screens concludes the product is
 * broken. Import this; never pass a literal colour to a chart.
 *
 * Values are CSS custom properties rather than hex so the theme can move them
 * — `--chart-8` in particular is a neutral that flips between light and dark,
 * because Okabe–Ito's eighth colour is black and no dark theme can use it.
 */
export const ASSET_CLASS_COLOR: Readonly<Record<AssetClass, string>> = {
  stock: 'var(--chart-1)',
  fii: 'var(--chart-2)',
  bdr: 'var(--chart-3)',
  etf: 'var(--chart-4)',
  tesouro_direto: 'var(--chart-5)',
  cdb: 'var(--chart-6)',
  lci: 'var(--chart-7)',
  lca: 'var(--chart-8)',
};

/** Every slot, in order — for series that are not asset classes (benchmarks, wallets). */
export const CHART_SERIES_COLORS: readonly string[] = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
];

/**
 * DS-11 — eight distinguishable hues is the ceiling for categorical encoding,
 * so this wraps rather than inventing a ninth. A caller with more than eight
 * categories has a grouping problem, not a palette problem: aggregate the tail
 * into "Outros" and offer a drill-down.
 */
export function chartColorAt(index: number): string {
  const slot = CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length];
  // The modulo above cannot miss, but `noUncheckedIndexedAccess` cannot know
  // that and DV-03 bars the non-null assertion that would silence it.
  return slot ?? 'var(--chart-1)';
}

export function assetClassColor(assetClass: AssetClass): string {
  return ASSET_CLASS_COLOR[assetClass];
}
