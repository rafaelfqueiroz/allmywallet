import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * The out-of-chart legend that ChartContainer renders below the plot.
 *
 * Each entry pairs its swatch with its label as text. That is what makes the
 * chart readable to someone who cannot tell two of the eight hues apart:
 * Okabe–Ito keeps the wedges distinguishable, and the label makes the question
 * moot. The swatch is `aria-hidden` — it carries no information the label does
 * not already carry.
 */
export type ChartLegendEntry = {
  readonly label: React.ReactNode;
  /** A `var(--chart-N)` reference from palette.ts, never a literal colour. */
  readonly color: string;
  /** Optional formatted figure — a share, a value. */
  readonly value?: React.ReactNode;
};

export function ChartLegend({
  entries,
  className,
}: {
  entries: readonly ChartLegendEntry[];
  className?: string;
}) {
  return (
    <ul data-slot="chart-legend" className={cn('flex flex-wrap gap-x-4 gap-y-1', className)}>
      {entries.map((entry, index) => (
        <li key={index} className="flex items-center gap-1.5 text-xs">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-xs"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-muted-foreground">{entry.label}</span>
          {entry.value && <span className="tabular-nums">{entry.value}</span>}
        </li>
      ))}
    </ul>
  );
}
