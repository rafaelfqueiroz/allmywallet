import type { EarningType } from '@/core/reporting/ports';
import type { Money as MoneyValue } from '@/core/shared/money';
import { StatCard } from '@/components/patterns/stat-card';
import { Grid } from '@/components/layout/grid';
import { Money } from '@/components/patterns/money';

/**
 * SPEC-014 BR-014-01 — the period's proventos, broken out by type: dividend,
 * JCP, rendimento, amortization and, since #113 (DL-014-08), leilão de
 * frações.
 *
 * Extracted from `page.tsx` so the fifth bucket has its own render test
 * (`ByTypeBreakdown.test.tsx`), independent of the report's full data
 * pipeline. `report.byType` already carries every `EARNING_TYPES` entry —
 * `core/reporting/earnings/received.ts`'s `totalsByType` is driven from the
 * type list, not from the data, so a type that paid nothing in the period is
 * still shown at zero rather than omitted — so this component only ever maps
 * what it is given; it does not decide which types exist or how many there
 * are (no hardcoded count, unlike a fixed `Grid cols`).
 */
export interface ByTypeItem {
  readonly type: EarningType;
  readonly label: string;
  readonly amount: MoneyValue;
}

export function ByTypeBreakdown({ items }: { readonly items: readonly ByTypeItem[] }) {
  return (
    <Grid cols={4} gap="md">
      {items.map((item) => (
        <StatCard key={item.type} label={item.label} value={<Money value={item.amount} />} />
      ))}
    </Grid>
  );
}
