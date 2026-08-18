'use client';

import { Cell, Pie, PieChart, Tooltip } from 'recharts';
import {
  ChartContainer,
  chartMarkProps,
  chartTooltipProps,
} from '@/components/charts/chart-container';

/**
 * SPEC-015 BR-015-01/07 — the share-of-total visualization.
 *
 * **A donut rather than a bar chart**, because the question this report opens
 * with is "what fraction of my money is in each of these", and a ring answers
 * a part-of-whole question without the reader having to add the bars up.
 *
 * **Every number here is a plotting coordinate, never a figure a user reads.**
 * `Money` does not cross the server/client boundary — it is a class instance,
 * so it would not survive serialisation, and AR-06/AR-10 would not let it be a
 * `number` if it did. The authoritative figures are rendered from `Money` on
 * the server, in the table beneath and in the summary this chart carries
 * (SPEC-016 BR-016-16).
 *
 * The `summary` is required by `ChartContainer` and is the whole accessibility
 * story for a ring of coloured wedges: it lists the same shares as text.
 */

export interface ShareChartSlice {
  readonly key: string;
  /** Already resolved through i18n or tenant data — this component renders it verbatim. */
  readonly label: string;
  /** A `var(--chart-N)` reference from `palette.ts`, never a literal colour. */
  readonly color: string;
  /** A plotting coordinate. See the header. */
  readonly value: number;
  /** The share, already formatted — for the tooltip. */
  readonly shareText: string;
}

export function ShareChart({
  slices,
  title,
  summary,
}: {
  readonly slices: readonly ShareChartSlice[];
  readonly title: string;
  readonly summary: React.ReactNode;
}) {
  return (
    <ChartContainer title={title} summary={summary} height={300}>
      <PieChart>
        <Pie
          data={[...slices]}
          dataKey="value"
          nameKey="label"
          // A ring, not a disc: the hole is what stops the eye reading the
          // wedges as areas to compare and pushes it to the arc lengths, which
          // are the thing that is actually proportional.
          innerRadius="55%"
          outerRadius="82%"
          paddingAngle={1}
          isAnimationActive={false}
        >
          {slices.map((slice) => (
            <Cell key={slice.key} fill={slice.color} {...chartMarkProps} />
          ))}
        </Pie>
        <Tooltip
          {...chartTooltipProps}
          formatter={(_value, _name, entry) => [
            (entry?.payload as ShareChartSlice | undefined)?.shareText ?? '',
            (entry?.payload as ShareChartSlice | undefined)?.label ?? '',
          ]}
        />
      </PieChart>
    </ChartContainer>
  );
}
