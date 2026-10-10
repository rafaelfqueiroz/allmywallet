import type * as React from 'react';
import { Badge } from '@/components/ui/badge';

/**
 * SPEC-007 BR-007-06 (amended 2026-09-21) / DL-007-12 — "an estimated cost is
 * carried and shown, never hidden." A position whose open lot includes an
 * acquisition B3 states no price for (a subscription, and anything carried or
 * converted from one) reads as estimated everywhere its cost or *preço médio*
 * is shown: the reports table, Composição's holdings table, the wallet
 * comparison and a wallet's own allocations, and the deletion-impact
 * disclosure's replayed positions.
 *
 * **One label, two explanations** (SPEC-022 BR-022-32, `common.estimated` —
 * "Estimado"). Every estimated value carries the same word beside the figure
 * it qualifies; the screens used to mix "Estimado" and "Preço estimado". What
 * stays distinct is the *explanation* (`title`), because this is a different
 * fact from `reports.markers.estimated` / `reports.estimate.*` (SPEC-009's
 * *valuation* estimate — an accrued fixed-income price, computed from a
 * contracted indexer rather than observed in the market). This one says where
 * the *cost* came from, that one says how the *current value* was priced. A
 * CDB's accrued value is always a valuation estimate and never a cost estimate
 * (its rate is contracted, not guessed); a subscribed FII trading normally
 * today is never a valuation estimate and can still be a cost estimate
 * (BR-007-06). The badge sits next to the Custo or *preço médio* it qualifies,
 * and its tooltip says which of the two it is — folding the explanations
 * together would tell one holder their fixed-income price is a guess and the
 * other that their subscription cost is accrued.
 *
 * `label` and `title` arrive pre-translated (AR-44), which keeps this a
 * plain, synchronous component — directly unit-testable, the same decision
 * `StateBadge` makes for the watch-state badge.
 */
export interface CostEstimateMarkerProps {
  readonly shown: boolean;
  /** Translated text (AR-44) — the visible badge. */
  readonly label: string;
  /** An accessible, translated explanation shown on hover/focus. */
  readonly title: string;
  readonly className?: string;
}

export function CostEstimateMarker({
  shown,
  label,
  title,
  className,
}: CostEstimateMarkerProps): React.JSX.Element | null {
  if (!shown) return null;
  return (
    <Badge variant="outline" title={title} className={className}>
      {label}
    </Badge>
  );
}
