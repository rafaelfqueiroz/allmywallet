import type { AssetClass } from '@/core/quotes/ports';

/**
 * SPEC-009 BR-009-12 / AC-10 — which asset classes carry the "no tax deducted"
 * disclosure.
 *
 * **Deliberately not `FIXED_INCOME_CLASSES` from `core/valuation/holdings.ts`.**
 * That set answers a *valuation* question — which instruments are priced by
 * accruing a contracted indexer rather than by observing a market — and
 * therefore excludes Tesouro Direto, which is marked to market at its sell
 * price. This set answers a *tax* question, and Tesouro is fixed income for
 * that purpose exactly as a CDB is. Two different questions, two sets; merging
 * them would silently drop the disclosure from Tesouro the next time someone
 * changed how it is valued.
 */
const TAXED_AS_FIXED_INCOME: ReadonlySet<AssetClass> = new Set<AssetClass>([
  'tesouro_direto',
  'cdb',
  'lci',
  'lca',
]);

/**
 * True when anything in view is fixed income, and the disclosure therefore has
 * to be on screen.
 *
 * Rendered conditionally rather than always: a note that appears on every page
 * regardless of what is on it is one users learn to stop reading, which
 * defeats the only thing a disclosure is for.
 */
export function hasFixedIncome(assetClasses: Iterable<AssetClass>): boolean {
  for (const assetClass of assetClasses) {
    if (TAXED_AS_FIXED_INCOME.has(assetClass)) return true;
  }
  return false;
}
