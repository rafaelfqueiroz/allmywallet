'use client';

import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  chartAxisProps,
  chartGridProps,
  chartTooltipProps,
} from '@/components/charts/chart-container';

/**
 * SPEC-019 BR-019-09..13 / AC-4 — the growth burn-up: the wallet's real line
 * plus a flat goal line, and nothing else.
 *
 * **No pace line and no projection here, on purpose** (BR-019-10, DL-019-01).
 * A goal has an amount and no target date, so there is nothing to be ahead of
 * or behind schedule on. `goal` is the same number repeated at every sampled
 * date — it can only ever render horizontally, which is the point: it is
 * geometrically impossible for this component to draw a trend line by
 * accident.
 *
 * **BR-019-13 — this chart is never year-scoped.** The page that calls it
 * must not slice `points` by year; nothing here does either.
 *
 * AR-06/AR-10: every number here is a plotting coordinate, never a figure a
 * user reads — exactly the discipline `ValueChart.tsx` (SPEC-013) documents at
 * length. The authoritative figures are the `<Money>` elements in the
 * summary this chart is described by and in the table beneath it.
 */
export interface GrowthChartPoint {
  readonly date: string;
  /**
   * `null` for a `GrowthPoint` of `kind: 'unavailable'` — rendered as a gap
   * (`connectNulls={false}`), never as zero. A missing cost basis or an
   * unpriceable holding is a fact the product does not know, not a fact that
   * the wallet was worth nothing that day.
   */
  readonly value: number | null;
  /** The goal amount, repeated at every point so the line it draws is flat. */
  readonly goal: number;
}

export function GrowthChart({
  points,
  title,
  summary,
  labels,
}: {
  readonly points: readonly GrowthChartPoint[];
  readonly title: string;
  readonly summary: React.ReactNode;
  readonly labels: { readonly value: string; readonly goal: string };
}) {
  return (
    <ChartContainer title={title} summary={summary} height={280}>
      <LineChart data={[...points]} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid {...chartGridProps} />
        <XAxis dataKey="date" {...chartAxisProps} minTickGap={32} />
        <YAxis {...chartAxisProps} width={72} />
        <Tooltip {...chartTooltipProps} />
        <Line
          type="monotone"
          dataKey="value"
          name={labels.value}
          stroke="var(--chart-1)"
          strokeWidth={2}
          // A dot per point on a multi-year series is noise; the shape is
          // what this chart is for, and the exact figures live in the table.
          dot={false}
          // The honest gap: an unavailable point must not be bridged as
          // though the line passed smoothly through a value nobody knows.
          connectNulls={false}
          isAnimationActive={false}
        />
        {/*
          BR-019-10 — the goal line. `dataKey="goal"` is a constant repeated at
          every sampled date, so `type="linear"` draws exactly one straight,
          horizontal segment — there is no schedule for it to lean toward.
        */}
        <Line
          type="linear"
          dataKey="goal"
          name={labels.goal}
          stroke="var(--chart-5)"
          strokeWidth={2}
          strokeDasharray="6 4"
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}
