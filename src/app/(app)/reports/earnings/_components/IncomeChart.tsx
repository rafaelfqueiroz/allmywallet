'use client';

import { Bar, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  chartAxisProps,
  chartGridProps,
  chartMarkProps,
  chartTooltipProps,
} from '@/components/charts/chart-container';

/**
 * SPEC-014 BR-014-03 / DL-014-03 — monthly bars **with** a twelve-month
 * trailing average.
 *
 * The two marks answer different halves of one question. Brazilian payers are
 * irregular — quarterly, semi-annual, one-off — so the bars alone read as
 * noise, and a reader cannot tell a growing portfolio from a lumpy one.
 * Aggregating to quarters would smooth the bars and lose the FII rendimentos,
 * which are monthly and are the part an income investor watches most.
 *
 * The average is drawn only where it exists: `null` for the first eleven
 * months, which Recharts renders as a gap rather than as a line rising from
 * zero. That gap is the honest shape — there is no twelve-month average until
 * there are twelve months.
 */
export interface IncomePoint {
  readonly month: string;
  readonly amount: number;
  readonly average: number | null;
}

export function IncomeChart({
  points,
  title,
  summary,
  labels,
}: {
  readonly points: readonly IncomePoint[];
  readonly title: string;
  readonly summary: React.ReactNode;
  readonly labels: { readonly bars: string; readonly average: string };
}) {
  return (
    <ChartContainer title={title} summary={summary} height={260}>
      <ComposedChart data={[...points]} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid {...chartGridProps} />
        <XAxis dataKey="month" {...chartAxisProps} minTickGap={24} />
        <YAxis {...chartAxisProps} width={72} />
        <Tooltip {...chartTooltipProps} />
        <Bar
          dataKey="amount"
          name={labels.bars}
          fill="var(--chart-3)"
          isAnimationActive={false}
          {...chartMarkProps}
        />
        {/* `connectNulls={false}`: the months before the window fills have no
            average, and joining across them would draw a trend that was never
            computed. */}
        <Line
          type="monotone"
          dataKey="average"
          name={labels.average}
          // DS-33's `chartMarkProps` is deliberately not spread here: its
          // background-coloured stroke exists to outline a filled mark, and on
          // a line the stroke *is* the series colour.
          stroke="var(--chart-5)"
          strokeWidth={2}
          connectNulls={false}
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ChartContainer>
  );
}
