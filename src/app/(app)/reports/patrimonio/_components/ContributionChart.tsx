'use client';

import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  chartAxisProps,
  chartGridProps,
  chartTooltipProps,
} from '@/components/charts/chart-container';

/**
 * SPEC-013 BR-013-06 — monthly net contribution bars.
 *
 * Plotting coordinates only; see `ValueChart.tsx`'s header for why plain
 * numbers are correct here and where the authoritative figures live.
 *
 * **A withdrawal month must render below the axis, not as a short bar.** The
 * spec calls out negative months explicitly because they are exactly what a
 * user goes looking for, and a chart that clamps at zero — or that colours
 * every bar the same — hides them. Hence the explicit `ReferenceLine` at zero
 * and the per-`Cell` colour, which is the redundant cue DL-05 requires: sign
 * is carried by *position* relative to the axis as well as by hue, so the
 * distinction survives a colour-blind reader and a greyscale print.
 */

export interface ContributionBar {
  readonly month: string;
  /** Plotting coordinate only. */
  readonly amount: number;
}

export function ContributionChart({
  bars,
  title,
  summary,
}: {
  readonly bars: readonly ContributionBar[];
  readonly title: string;
  readonly summary: React.ReactNode;
}) {
  return (
    <ChartContainer title={title} summary={summary} height={240}>
      <BarChart data={[...bars]} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid {...chartGridProps} />
        <XAxis dataKey="month" {...chartAxisProps} minTickGap={24} />
        <YAxis {...chartAxisProps} width={72} />
        <Tooltip {...chartTooltipProps} />
        {/* Without an explicit zero line a chart of all-positive months and one
            of mixed months look identical at a glance. */}
        <ReferenceLine y={0} stroke="var(--color-border)" />
        <Bar dataKey="amount" isAnimationActive={false}>
          {bars.map((bar) => (
            <Cell
              key={bar.month}
              fill={bar.amount < 0 ? 'var(--color-negative)' : 'var(--chart-2)'}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
