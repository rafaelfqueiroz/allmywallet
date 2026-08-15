'use client';

import type { ReactElement, ReactNode } from 'react';
import { useId } from 'react';
import { ResponsiveContainer } from 'recharts';
import { cn } from '@/lib/utils';

/**
 * The frame every chart in the product sits in, and the reason charts are part
 * of the design system rather than an afterthought (#33).
 *
 * It carries three things no individual chart should re-decide:
 *
 * - **An accessible name and a text alternative.** A `<svg>` of coloured
 *   wedges is nothing to a screen reader. `summary` renders visually hidden
 *   next to the chart and is where the figures actually live; SPEC-016
 *   BR-016-15's axe assertions are satisfied by this rather than by each chart
 *   inventing its own aria.
 * - **A height.** Recharts' ResponsiveContainer needs a bounded parent or it
 *   collapses to zero, which is the single most common way a chart ships
 *   invisible.
 * - **Small-screen behaviour.** Below `md` the legend moves out of the SVG and
 *   renders as a plain list underneath, because an in-chart legend on a 375px
 *   viewport eats the plot area it is meant to explain (DL-12).
 */
export type ChartContainerProps = {
  /** Accessible name. Translated text — AR-44. */
  title: ReactNode;
  /**
   * A text equivalent of what the chart shows — the same numbers, as prose or
   * a list. Required, because a chart without one is inaccessible by
   * construction rather than by oversight.
   */
  summary: ReactNode;
  /** Rendered below the plot on small screens, inside it on large ones. */
  legend?: ReactNode;
  height?: number;
  className?: string;
  children: ReactElement;
};

export function ChartContainer({
  title,
  summary,
  legend,
  height = 280,
  className,
  children,
}: ChartContainerProps) {
  const titleId = useId();
  const summaryId = useId();

  return (
    <figure data-slot="chart" className={cn('w-full', className)} aria-labelledby={titleId}>
      <figcaption id={titleId} className="sr-only">
        {title}
      </figcaption>

      <div role="img" aria-labelledby={titleId} aria-describedby={summaryId} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>

      <div id={summaryId} className="sr-only">
        {summary}
      </div>

      {legend && <div className="mt-2 md:mt-3">{legend}</div>}
    </figure>
  );
}

/**
 * Shared axis, grid and tooltip props. Spread these rather than restating them
 * — two reports with different tick formatting look like two products.
 */
export const chartAxisProps = {
  stroke: 'var(--color-muted-foreground)',
  fontSize: 12,
  tickLine: false,
  axisLine: false,
} as const;

export const chartGridProps = {
  stroke: 'var(--color-border)',
  strokeDasharray: '3 3',
  vertical: false,
} as const;

export const chartTooltipProps = {
  contentStyle: {
    background: 'var(--color-popover)',
    color: 'var(--color-popover-foreground)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    fontSize: '0.8rem',
  },
  cursor: { fill: 'var(--color-muted)' },
} as const;

/**
 * DS-10's caveat, applied. `--chart-4` is Okabe–Ito's yellow, which is
 * low-contrast against a light background; every filled mark therefore carries
 * a background-coloured stroke so its edge stays visible in both themes.
 */
export const chartMarkProps = {
  stroke: 'var(--color-background)',
  strokeWidth: 1,
} as const;
