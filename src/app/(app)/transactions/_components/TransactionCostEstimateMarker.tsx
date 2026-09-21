import type * as React from 'react';
import type { BusinessDate } from '@/core/shared/clock';
import { Badge } from '@/components/ui/badge';

/**
 * SPEC-007 BR-007-06 (amended 2026-09-21) / SPEC-005 BR-005-20d — marks a
 * single transaction whose `unitPrice`/`costBasis` is an estimate rather than
 * a figure B3 stated, and says *why* in the two shapes DL-007-11 draws:
 *
 *  - **A subscription priced at a stored close** (`estimateCloseDate` set):
 *    B3 never states a subscription's price, so the cost is the close on the
 *    day the shares were credited.
 *  - **A carried estimate** — a transfer or conversion leg whose source lot
 *    included one (`estimateCloseDate` null, DL-007-11): a carried cost is an
 *    average over a lot that may mix estimates and exact buys, so no single
 *    close date is true of it.
 *
 * `label` and the two explanation builders arrive pre-translated (AR-44),
 * which keeps this a plain, synchronous component: the three states —
 * hidden, shown with a close date, shown carried — are directly
 * unit-testable with no `next-intl` server machinery in the test.
 */
export interface TransactionCostEstimateMarkerProps {
  readonly costIsEstimate: boolean;
  readonly estimateCloseDate: BusinessDate | null;
  /** Translated text (AR-44) — the visible badge. */
  readonly label: string;
  /** `t('...closeExplanation', { date })`, already substituted. */
  readonly closeExplanation: (date: BusinessDate) => string;
  /** `t('...carriedExplanation')`. */
  readonly carriedExplanation: string;
  readonly className?: string;
}

export function TransactionCostEstimateMarker({
  costIsEstimate,
  estimateCloseDate,
  label,
  closeExplanation,
  carriedExplanation,
  className,
}: TransactionCostEstimateMarkerProps): React.JSX.Element | null {
  if (!costIsEstimate) return null;

  const title = estimateCloseDate === null ? carriedExplanation : closeExplanation(estimateCloseDate);

  return (
    <Badge variant="outline" title={title} className={className}>
      {label}
    </Badge>
  );
}
