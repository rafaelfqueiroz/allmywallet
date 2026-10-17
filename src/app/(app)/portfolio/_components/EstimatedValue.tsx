import { getTranslations } from 'next-intl/server';
import type { Money as MoneyValue } from '@/core/shared/money';
import { Money } from '@/app/money';
import { Cluster } from '@/components/layout/cluster';
import { EstimateMarker } from '@/components/patterns/estimate-marker';

/**
 * A market value with SPEC-009's estimate marker beside it, when any figure
 * folded into it was accrued or fell back to cost rather than observed
 * (BR-011-15, `ReportTotals.estimated`).
 *
 * One component for every value Portfólio totals — the headline, a class card,
 * a wallet's row and the comparison's total — so none of them can show an
 * accrued CDB as if it were a quote. The marker reads "Valor estimado" and sits
 * beside the figure it qualifies (BR-022-32, DL-022-19), distinct from the
 * "Custo estimado" a cost carries; its explanation opens from an info icon.
 */
export async function EstimatedValue({
  value,
  estimated,
  justify,
}: {
  readonly value: MoneyValue;
  readonly estimated: boolean;
  /** `end` inside a right-aligned table cell. */
  readonly justify?: 'end';
}) {
  if (!estimated) return <Money value={value} />;

  const t = await getTranslations('reports');

  return (
    <Cluster gap="sm" align="baseline" {...(justify ? { justify } : {})}>
      <Money value={value} />
      <EstimateMarker kind="value" explanation={t('estimate.totalExplanation')} />
    </Cluster>
  );
}
