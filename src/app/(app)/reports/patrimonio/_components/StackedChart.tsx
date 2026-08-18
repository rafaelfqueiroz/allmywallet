'use client';

import { Area, AreaChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  chartAxisProps,
  chartGridProps,
  chartTooltipProps,
} from '@/components/charts/chart-container';

/**
 * SPEC-013 BR-013-05 / #63 — composition over time.
 *
 * **This chart was computed and never drawn.** `stackedSeries` has produced
 * bands since #48, and `patrimonio/page.tsx` rendered a Section only for the
 * `unavailable` branch — so the one grouping that *can* be answered
 * (`asset_class`, the only historical breakdown `daily_valuation_snapshots`
 * stores) fell through to nothing. Changing "Agrupar por" therefore appeared
 * to do nothing on this report whichever value was chosen: four dimensions
 * explained themselves, and the fifth silently drew no chart at all.
 *
 * Every number here is a plotting coordinate, never a figure a user reads —
 * see `ValueChart.tsx`'s header for why that does not breach AR-06/AR-10. The
 * authoritative figures are in the table beneath (SPEC-016 BR-016-16).
 */

export interface StackedChartBand {
  readonly key: string;
  /** The rendered band name — already resolved through i18n or tenant data. */
  readonly label: string;
  readonly color: string;
}

/** One row per date, with one plotting coordinate per band key. */
export type StackedChartRow = Readonly<Record<string, string | number>>;

export function StackedChart({
  rows,
  bands,
  title,
  summary,
}: {
  readonly rows: readonly StackedChartRow[];
  readonly bands: readonly StackedChartBand[];
  readonly title: string;
  readonly summary: React.ReactNode;
}) {
  return (
    <ChartContainer title={title} summary={summary} height={320}>
      <AreaChart data={[...rows]} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid {...chartGridProps} />
        <XAxis dataKey="date" {...chartAxisProps} minTickGap={32} />
        <YAxis {...chartAxisProps} width={72} />
        <Tooltip {...chartTooltipProps} />
        <Legend />
        {bands.map((band) => (
          <Area
            key={band.key}
            type="monotone"
            // One `stackId` across every band is what makes this a composition
            // rather than five overlapping area charts: the bands sum to the
            // portfolio total at each date, which is the claim BR-013-05 makes.
            stackId="composition"
            dataKey={band.key}
            name={band.label}
            stroke={band.color}
            fill={band.color}
            fillOpacity={0.65}
            strokeWidth={1}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );
}
