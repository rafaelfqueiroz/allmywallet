import type { Money as MoneyValue } from '@/core/shared/money';
import { Money } from '@/app/money';
import { Cluster } from '@/components/layout/cluster';

/**
 * #233 — "+2,14% (+R$ 13.689,37) vs. 30/09/2026" under a headline figure: the
 * percentage, the signed amount, and what it is measured against.
 *
 * Both through `Money` (DS-09): the sign and its colour are the pattern's, and
 * the amount masks with the eye toggle while the percentage stays (DS-59,
 * DL-022-07) — so a masked screen still says which way the figure moved.
 *
 * `ratio` is `null` when the base was zero: the amount alone, never an
 * invented percentage (SPEC-014 BR-014-07).
 */
export function MonthChange({
  ratio,
  change,
  against,
}: {
  readonly ratio: MoneyValue | null;
  readonly change: MoneyValue;
  /** The already-worded comparison, e.g. "vs. setembro". */
  readonly against: string;
}) {
  return (
    <Cluster gap="xs" align="baseline" data-slot="month-change">
      {ratio === null ? (
        <Money value={change} signed />
      ) : (
        <>
          <Money value={ratio} kind="percent" signed />
          <span>
            (<Money value={change} signed />)
          </span>
        </>
      )}
      <span>{against}</span>
    </Cluster>
  );
}
