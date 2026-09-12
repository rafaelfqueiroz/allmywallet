import { getTranslations } from 'next-intl/server';
import type { ValuationMarkers as Markers } from '@/core/dashboard/summary';
import { formatBusinessDate } from '@/i18n/format';
import { Badge } from '@/components/ui/badge';
import { Cluster } from '@/components/layout/cluster';

/**
 * SPEC-009 AC-3/AC-9/AC-11 — **how the total above was priced**, at portfolio
 * grain.
 *
 * `reports/_components/HoldingMarkers.tsx` makes this argument per row, and its
 * header records the defect that produced it: the engine distinguishes three
 * things and the screen collapsed them into one *Estimado* badge. The dashboard
 * is where that collapse costs most, because there is a single number over the
 * whole portfolio and no row underneath it to go and look at — so the one
 * caveat shown has to be the right one.
 *
 * The failure this closes, concretely: a user holding PETR4 and one newly
 * listed BDR with no quote row was told the estimate came from *renda fixa
 * acruada* they do not own, while BR-009-13's "this is not a valuation, act on
 * it" signal never appeared at all.
 *
 * **Colour is never the sole carrier (BR-016-16).** Each badge's meaning is its
 * text; the `title` adds the explanation, and a `title` survives a print, a
 * screen reader and a page with JavaScript disabled.
 */
export async function ValuationMarkers({ markers }: { readonly markers: Markers }) {
  const t = await getTranslations('dashboard.markers');

  const badges: React.ReactNode[] = [];

  // BR-009-13 first: the only one of the three that asks the user to do
  // something, and the only one styled as a problem.
  if (markers.unpriced > 0) {
    badges.push(
      <Badge
        key="attention"
        variant="destructive"
        title={t('attention.explanation', { count: markers.unpriced })}
      >
        {t('attention.badge')}
      </Badge>,
    );
  }

  if (markers.accrued) {
    badges.push(
      <Badge key="accrued" variant="outline" title={t('accrued.explanation')}>
        {t('accrued.badge')}
      </Badge>,
    );
  }

  if (markers.carriedForward && markers.oldestPriceDate !== null) {
    // BR-008-24 — "never shown as current when it is not". The date is the
    // *oldest* behind the total, because the quote instant beside it is already
    // the freshest and the two together are what make the gap visible.
    badges.push(
      <Badge key="carried" variant="secondary" title={t('carried.explanation')}>
        {t('carried.badge', { date: formatBusinessDate(markers.oldestPriceDate) })}
      </Badge>,
    );
  }

  if (badges.length === 0) return null;

  return (
    <Cluster gap="sm" align="baseline">
      {badges}
    </Cluster>
  );
}
