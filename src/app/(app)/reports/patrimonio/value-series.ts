import type { Money } from '@/core/shared/money';
import type { ValuePoint } from '@/core/reporting/portfolio-value/ports';
import type { ValueChartPoint } from '@/app/(app)/reports/patrimonio/_components/ValueChart';

/**
 * SPEC-013 / SPEC-021 BR-021-31 — how a snapshot point is *presented*, kept
 * out of `page.tsx` so the one decision that matters here is testable without
 * rendering a Server Component.
 *
 * A gap day is a date whose market close for a held asset could not be
 * recovered. Its snapshot still exists — SPEC-009 BR-009-03 values it from the
 * previous close — but that figure is carried forward, not observed, so:
 *
 *   - the chart plots `null`, which is a break in the line, never a bridge;
 *   - the table (the chart's text equivalent, SPEC-016 BR-016-16) labels it
 *     with its own basis, never "observed".
 *
 * `gap` outranks `estimated`: a gap day that also holds accrued fixed income
 * is still, first, a day with a missing close.
 */
export type ValueBasis = 'gap' | 'estimated' | 'observed';

export function basisOf(point: ValuePoint, gapDates: ReadonlySet<string>): ValueBasis {
  if (gapDates.has(point.date)) return 'gap';
  return point.estimated ? 'estimated' : 'observed';
}

/**
 * The server/client boundary for chart geometry. `Money` never crosses it —
 * see `ValueChart.tsx`'s header. Every figure a user *reads* is rendered from
 * `Money` on the server, in the summaries and the table.
 */
export const plot = (value: Money): number => Number(value.toString());

export function toValueChartPoints(
  series: readonly ValuePoint[],
  gapDates: ReadonlySet<string>,
): ValueChartPoint[] {
  return series.map((point) => {
    const gap = gapDates.has(point.date);
    return {
      date: point.date,
      value: gap ? null : plot(point.value),
      estimated: point.estimated,
      gap,
    };
  });
}
