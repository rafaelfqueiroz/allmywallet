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
 * SPEC-019 BR-019-15..21 — the earnings goal's chart: exactly the twelve
 * months of one calendar year, never crossing into another.
 *
 * **BR-019-15/16 — the two periods are drawn differently, not just labelled
 * differently.** A `monthly` goal is compared against the bars themselves —
 * one good month is the whole claim. A `yearly` goal gains a `cumulative`
 * line, because a flat line at an annual figure means nothing next to a single
 * month's bar; the accumulation is what actually approaches it.
 *
 * **BR-019-17's average is drawn either way.** It belongs to the bars, not to
 * the goal — see the comment at the series itself.
 *
 * **BR-019-18 — this chart's average is the year-to-date one, and the label
 * passed in must say so.** It is not `IncomeChart`'s twelve-month moving
 * average, even though both are called "average" in English: one resets every
 * January and reads nothing outside the selected year (DL-019-03), the other
 * is a trailing window that can span two calendar years. Two different pt-BR
 * labels exist for exactly this reason — see `page.tsx` and SPEC-014's own
 * `reports/earnings/page.tsx`.
 *
 * **BR-019-19 — nothing here may introduce a month outside the selected
 * year.** `points` already carries only the twelve months of that year (a
 * `not_elapsed` month is included with every value `null`, so the axis still
 * shows the whole year's shape); this component adds no padding of its own.
 */
export interface EarningsChartPoint {
  readonly month: string;
  /** `null` for a `not_elapsed` month — no bar, never a fabricated zero. */
  readonly amount: number | null;
  /** Only meaningful for a `yearly` goal; `null` otherwise and for `not_elapsed` months. */
  readonly cumulative: number | null;
  /** Only meaningful for a `monthly` goal; `null` otherwise and for `not_elapsed` months. */
  readonly yearToDateAverage: number | null;
  /** The goal amount, repeated at every month so the reference line is flat. */
  readonly goal: number;
}

export function EarningsGoalChart({
  points,
  period,
  title,
  summary,
  labels,
}: {
  readonly points: readonly EarningsChartPoint[];
  readonly period: 'monthly' | 'yearly';
  readonly title: string;
  readonly summary: React.ReactNode;
  readonly labels: {
    readonly bars: string;
    readonly average: string;
    readonly cumulative: string;
    readonly goal: string;
  };
}) {
  return (
    <ChartContainer title={title} summary={summary} height={280}>
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
        {/*
          BR-019-17 — the year-to-date average accompanies the monthly bars,
          and it does so **whatever period the goal names**. The rule is
          written about the bars, not about the goal: it is the line that makes
          a lumpy Brazilian payer readable (DL-014-02's finding, DL-019-03's
          replacement for it), and AC-9 asserts its January and December values
          on this chart without qualifying by period. Drawing it only for a
          monthly goal would leave a wallet whose only goal is annual with a
          chart that carries no average at all — and AC-10, which requires each
          chart to name which average it shows, would have nothing to name.
        */}
        <Line
          type="monotone"
          dataKey="yearToDateAverage"
          name={labels.average}
          stroke="var(--chart-5)"
          strokeWidth={2}
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
        {period === 'yearly' && (
          // BR-019-16 — the yearly goal is measured against the running total,
          // which is what a flat annual figure can meaningfully be compared
          // to; a monthly bar never approaches a year's worth of income, so
          // without this the goal line would sit far above every mark on the
          // chart and say nothing. Additional to the average rather than
          // instead of it.
          <Line
            type="monotone"
            dataKey="cumulative"
            name={labels.cumulative}
            stroke="var(--chart-2)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        )}
        {/* The goal itself: constant across all twelve months, so this can
            only ever render as one flat, dashed line — never a schedule. */}
        <Line
          type="linear"
          dataKey="goal"
          name={labels.goal}
          stroke="var(--chart-6)"
          strokeWidth={2}
          strokeDasharray="6 4"
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ChartContainer>
  );
}
