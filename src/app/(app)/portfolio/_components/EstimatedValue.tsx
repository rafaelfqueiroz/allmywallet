import { getTranslations } from 'next-intl/server';
import type { Money as MoneyValue } from '@/core/shared/money';
import { Money } from '@/app/money';
import { Cluster } from '@/components/layout/cluster';
import { Badge } from '@/components/ui/badge';

/**
 * A market value with SPEC-009's estimate marker beside it, when any figure
 * folded into it was accrued or fell back to cost rather than observed
 * (BR-011-15, `ReportTotals.estimated`).
 *
 * One component for every value Portfólio totals — the headline, a class card,
 * a wallet's row and the comparison's total — so none of them can show an
 * accrued CDB as if it were a quote. The label is `common.estimated` and sits
 * beside the figure it qualifies (BR-022-32, DESIGN.md "One concept, one
 * wording"); the explanation says it is the *value* that was estimated, which
 * keeps it distinct from the cost estimate (`CostEstimateMarker`).
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
  const tCommon = await getTranslations('common');

  return (
    <Cluster gap="sm" align="baseline" {...(justify ? { justify } : {})}>
      <Money value={value} />
      <Badge variant="outline" title={t('estimate.explanation')}>
        {tCommon('estimated')}
      </Badge>
    </Cluster>
  );
}
