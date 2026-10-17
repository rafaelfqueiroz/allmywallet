'use client';

import { useId, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { InfoTip } from '@/components/patterns/info-tip';

/**
 * Which of the two estimates a figure carries (SPEC-022 BR-022-32, DL-022-19).
 *
 * - `value` — **Valor estimado**: a value priced from a contracted indexer
 *   rather than observed in a market (SPEC-009 BR-009-11), or one that fell
 *   back to acquisition cost because nothing ever priced it.
 * - `cost` — **Custo estimado**: a cost or *preço médio* whose open lot
 *   includes an acquisition B3 states no price for, such as a subscription
 *   (SPEC-007 BR-007-06).
 *
 * A CDB's accrued value is always a value estimate and never a cost estimate
 * (its rate is contracted, not guessed); a subscribed FII trading normally
 * today is never a value estimate and can still be a cost estimate. One word
 * for both — the old "Estimado" — is what left the owner unable to tell which
 * fact a badge was stating.
 */
export type EstimateKind = 'value' | 'cost';

const LABEL_KEY = { value: 'valueEstimated', cost: 'costEstimated' } as const;

export interface EstimateMarkerProps {
  readonly kind: EstimateKind;
  /** Translated (AR-44): the sentence saying where this figure came from. */
  readonly explanation: ReactNode;
  readonly className?: string;
}

/**
 * SPEC-022 BR-022-32 — the estimate label beside the figure it qualifies, with
 * an info icon whose explanation opens on hover, on keyboard focus and on tap
 * (BR-022-20). It used to be the badge's native `title`, which a phone never
 * shows and a keyboard never reaches.
 *
 * The label is chosen here from `kind`, never passed in, so a site cannot pair
 * the cost wording with a value or spell the label afresh. The explanation is
 * passed in because it varies by site — an accrual's basis on a holding row, a
 * subscription's close date on a transaction.
 *
 * As in `ValuationMarkers`, the explanation is also the icon's accessible
 * description, through a `hidden` copy: a screen reader hears it on reaching
 * the icon rather than only once the tip opens. A Client Component only for
 * `useId` — one table renders a marker per row, and each icon needs its own id.
 */
export function EstimateMarker({ kind, explanation, className }: EstimateMarkerProps) {
  const t = useTranslations('common');
  const id = useId();
  const label = t(LABEL_KEY[kind]);

  return (
    <Badge
      variant="outline"
      data-slot="estimate-marker"
      data-kind={kind}
      // `overflow-visible` so the icon's focus ring is not clipped by the pill.
      className={cn('overflow-visible pr-1', className)}
    >
      <span id={`${id}-label`}>{label}</span>
      <InfoTip
        id={id}
        label={label}
        labelledBy={`${id}-label`}
        describedBy={`${id}-explanation`}
        // A 24 px touch target in a 16 px layout box, so the pill keeps its height.
        className="-m-1 [&_svg]:size-3"
      >
        {explanation}
      </InfoTip>
      <span id={`${id}-explanation`} hidden>
        {explanation}
      </span>
    </Badge>
  );
}
