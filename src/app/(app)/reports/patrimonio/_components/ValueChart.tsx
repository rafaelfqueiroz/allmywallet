'use client';

import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  chartAxisProps,
  chartGridProps,
  chartTooltipProps,
} from '@/components/charts/chart-container';

/**
 * SPEC-013 BR-013-01 — the value line.
 *
 * **Every number in this file is a plotting coordinate, never a figure a user
 * reads.** AR-06/AR-10 bar money from being a JS `number`, and this does not
 * breach that: Recharts positions marks in pixels and cannot consume a
 * `Decimal`, so the series crosses the server/client boundary as plain numbers
 * *for geometry only*. The authoritative figures are rendered separately, from
 * `Money`, in the summary this chart is described by and in the table beneath
 * it — which is also what SPEC-016 BR-016-16 requires. If a reader can only
 * get a number by reading a pixel, the chart has failed twice over.
 */

export interface ValueChartPoint {
  readonly date: string;
  /** Plotting coordinate only — see the file header. */
  readonly value: number;
  readonly estimated: boolean;
}

export function ValueChart({
  points,
  title,
  summary,
}: {
  readonly points: readonly ValueChartPoint[];
  readonly title: string;
  readonly summary: React.ReactNode;
}) {
  return (
    <ChartContainer title={title} summary={summary} height={320}>
      <AreaChart data={[...points]} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <defs>
          <linearGradient id="patrimonio-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid {...chartGridProps} />
        <XAxis dataKey="date" {...chartAxisProps} minTickGap={32} />
        <YAxis {...chartAxisProps} width={72} />
        <Tooltip {...chartTooltipProps} />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--chart-1)"
          strokeWidth={2}
          fill="url(#patrimonio-fill)"
          // A dot per point on a five-year daily series is noise; the shape is
          // what this chart is for, and the exact figures live in the table.
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}
