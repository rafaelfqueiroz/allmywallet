import { getTranslations } from 'next-intl/server';
import type { ReportHolding } from '@/core/reporting/ports';
import { Badge } from '@/components/ui/badge';
import { Cluster } from '@/components/layout/cluster';

/**
 * SPEC-009 AC-3, AC-9 and AC-11 — how a single holding was priced, said on the
 * row itself.
 *
 * ---------------------------------------------------------------------------
 * WHY THREE MARKERS AND NOT ONE
 *
 * The engine distinguishes three different things and the screen used to
 * collapse them into a single "Estimado" badge — or, more often, into nothing
 * at all, because `core/reporting/ports.ts` carried only `estimated: boolean`
 * and dropped the rest at the boundary.
 *
 *  - **Needs attention** (BR-009-13): nothing could price this, so it sits at
 *    acquisition cost. The figure on screen is not a valuation at all. This is
 *    the only one of the three that asks the user to *do* something, so it is
 *    the only one styled as a problem.
 *  - **Estimated** (BR-009-11): accrued from a contracted indexer rather than
 *    observed in a market. A real figure, computed rather than seen — and
 *    AC-9 wants the reader to be able to find out *from what*, which is what
 *    the title carries.
 *  - **Carried forward** (BR-009-03): a real observed price, from an earlier
 *    date. A weekend, a holiday, a trading halt. Deliberately not folded into
 *    "estimated": doing so would mark every Saturday's entire portfolio an
 *    estimate and drain the word of meaning.
 *
 * A user looking at a suspended stock ten days after its last trade previously
 * saw a plain figure, indistinguishable on screen from a live quote. That is
 * the defect this closes.
 * ---------------------------------------------------------------------------
 */
export async function HoldingMarkers({ holding }: { readonly holding: ReportHolding }) {
  const t = await getTranslations('reports.markers');

  const markers: React.ReactNode[] = [];

  if (holding.needsAttention !== null) {
    markers.push(
      <Badge key="attention" variant="destructive" title={t(`attention.${holding.needsAttention}`)}>
        {t('attention.badge')}
      </Badge>,
    );
  }

  if (holding.estimated && holding.basis !== null) {
    // AC-9: the basis, on hover. Not a tooltip component — a `title` survives
    // a print, a screen reader and a page with JavaScript disabled, and this
    // is explanatory text rather than an interaction.
    markers.push(
      <Badge
        key="estimated"
        variant="outline"
        title={t('estimated.basis', {
          indexer: t(`indexer.${holding.basis.indexer}`),
          rate: holding.basis.ratePercent,
          days: holding.basis.businessDays,
          through: holding.basis.throughDate,
        })}
      >
        {t('estimated.badge')}
      </Badge>,
    );
  }

  if (holding.carriedForward && holding.priceDate !== null) {
    markers.push(
      <Badge key="carried" variant="secondary" title={t('carried.explanation')}>
        {t('carried.badge', { date: holding.priceDate })}
      </Badge>,
    );
  }

  if (markers.length === 0) return null;

  return (
    <Cluster gap="sm" align="baseline">
      {markers}
    </Cluster>
  );
}
