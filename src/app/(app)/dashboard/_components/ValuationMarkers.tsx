import { getTranslations } from 'next-intl/server';
import type { ValuationMarkers as Markers } from '@/core/dashboard/summary';
import { formatBusinessDate } from '@/i18n/format';
import { Badge } from '@/components/ui/badge';
import { Cluster } from '@/components/layout/cluster';
import { InfoTip } from '@/components/patterns/info-tip';
import { EstimateMarker } from '@/components/patterns/estimate-marker';

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
 * text, and its explanation sits behind an `InfoTip` beside it (#213, DS-55).
 * It used to be the badge's `title`, which a phone never shows and a keyboard
 * never reaches — so the one sentence that reconciles "Preço mais antigo"
 * with the freshest quote in the page header was out of reach for exactly the
 * users most likely to read both. The explanation is also the icon's
 * accessible description (`aria-describedby` on a `hidden` copy), so a screen
 * reader hears it on reaching the icon rather than only when the tip opens —
 * on the badge it would sit on plain text, which browse mode does not read.
 */
export async function ValuationMarkers({ markers }: { readonly markers: Markers }) {
  const t = await getTranslations('dashboard.markers');

  const badges: React.ReactNode[] = [];

  // BR-009-13 first: the only one of the three that asks the user to do
  // something, and the only one styled as a problem.
  if (markers.unpriced > 0) {
    badges.push(
      <Marker
        key="attention"
        id="marker-attention"
        // SPEC-022 BR-022-31 — asks for attention, so a warning; not a loss and
        // not a destructive action (DS-05).
        variant="warning"
        label={t('attention.badge')}
        explanation={t('attention.explanation', { count: markers.unpriced })}
      />,
    );
  }

  if (markers.accrued) {
    badges.push(
      // SPEC-022 BR-022-32 — the same "Valor estimado" every other value reads.
      <EstimateMarker key="accrued" kind="value" explanation={t('accrued.explanation')} />,
    );
  }

  if (markers.carriedForward && markers.oldestPriceDate !== null) {
    // BR-008-24 — "never shown as current when it is not". The date is the
    // *oldest* behind the total, because the intraday quote instant in the
    // page header is the freshest and the two together are what make the gap
    // visible. Worded as "mais antigo" so it reads as the other end of a range
    // rather than as a contradiction of the header (#213); the explanation
    // does not point at the header, which may name no quote at all.
    const date = formatBusinessDate(markers.oldestPriceDate);
    badges.push(
      <Marker
        key="carried"
        id="marker-carried"
        variant="neutral"
        label={t('carried.badge', { date })}
        explanation={t('carried.explanation', { date })}
      />,
    );
  }

  if (badges.length === 0) return null;

  return (
    <Cluster gap="sm" align="center">
      {badges}
    </Cluster>
  );
}

/** One marker: its badge, and its explanation reachable by hover, focus and tap. */
function Marker({
  id,
  variant,
  label,
  explanation,
}: {
  readonly id: string;
  readonly variant: 'warning' | 'neutral';
  readonly label: string;
  readonly explanation: string;
}) {
  return (
    <Cluster gap="xs" align="center" data-slot="valuation-marker">
      <Badge id={`${id}-badge`} variant={variant}>
        {label}
      </Badge>
      <InfoTip id={id} label={label} labelledBy={`${id}-badge`} describedBy={`${id}-explanation`}>
        {explanation}
      </InfoTip>
      <span id={`${id}-explanation`} hidden>
        {explanation}
      </span>
    </Cluster>
  );
}
