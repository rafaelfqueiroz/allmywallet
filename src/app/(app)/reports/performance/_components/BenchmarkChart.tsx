'use client';

import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  chartAxisProps,
  chartGridProps,
  chartTooltipProps,
} from '@/components/charts/chart-container';

/**
 * SPEC-012 BR-012-12 / DL-012-04 — the portfolio's cumulative return against
 * each benchmark's, on one pair of axes.
 *
 * **Growth factors, rebased to 100, not money.** The point of this chart is
 * comparison, and a portfolio worth R$ 40.000 plotted beside an index level of
 * 130.000 compares nothing — the shapes would be unreadable and the reader
 * would be invited to subtract two quantities that are not the same kind of
 * thing. Every line starts at 100 on the period's first date, so vertical
 * distance is the only thing on the chart and it means exactly what it looks
 * like: how far ahead or behind.
 *
 * **The lines are TWR, deliberately.** DL-012-01: using XIRR against an index
 * would let a well-timed large deposit make a mediocre portfolio look
 * brilliant, because XIRR rewards the timing of contributions and an index has
 * no contributions to time. XIRR is on the page, in the headline figures,
 * answering its own question.
 *
 * Every value plotted here is a coordinate, never a figure a user reads — the
 * authoritative returns are in the benchmark table beneath, rendered from
 * `Rate`. Same reasoning as `patrimonio/_components/ValueChart.tsx`, which has
 * the longer note.
 */

export interface ComparisonPoint {
  readonly date: string;
  /** Rebased to 100 at the period's start. Plotting coordinate only. */
  readonly [series: string]: string | number;
}

export function BenchmarkChart({
  points,
  series,
  title,
  summary,
}: {
  readonly points: readonly ComparisonPoint[];
  /** Line keys in render order; the first is the portfolio's own. */
  readonly series: readonly string[];
  readonly title: string;
  readonly summary: React.ReactNode;
}) {
  return (
    <ChartContainer title={title} summary={summary} height={320}>
      <LineChart data={[...points]} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid {...chartGridProps} />
        <XAxis dataKey="date" {...chartAxisProps} minTickGap={32} />
        <YAxis {...chartAxisProps} width={64} domain={['auto', 'auto']} />
        <Tooltip {...chartTooltipProps} />
        <Legend />
        {series.map((key, index) => (
          <Line
            key={key}
            type="monotone"
            dataKey={key}
            // The portfolio is `--chart-1` and thicker; benchmarks follow in
            // the palette. DL-05's redundant cue is carried by the legend and
            // by the table beneath, not by hue alone.
            stroke={`var(--chart-${index + 1})`}
            strokeWidth={index === 0 ? 2.5 : 1.5}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}
