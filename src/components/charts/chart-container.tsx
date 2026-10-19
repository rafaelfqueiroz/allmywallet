'use client';

import type { ReactElement, ReactNode } from 'react';
import { useId } from 'react';
import {
  ResponsiveContainer,
  type TooltipProps,
  type TooltipValueType,
  type XAxisProps,
  type YAxisProps,
} from 'recharts';
import {
  formatAxisCurrency,
  formatAxisDayMonth,
  formatAxisMonth,
  formatAxisMonthYear,
} from '@/i18n/format';
import { MASKED_CURRENCY } from '@/i18n/masked';
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

/**
 * SPEC-022 BR-022-42 — DS-33 for a **daily** series' `XAxis`, spread after
 * `chartAxisProps`: it ticks as "nov/25", never as the `2026-09-30` key.
 *
 * Only the first point of each month is a tick, so a month's label is printed
 * once rather than at every point Recharts would space out by `minTickGap`
 * (which still thins the month ticks on a multi-year range). A range spanning
 * fewer than `MONTH_TICKS_FROM` months would carry one or two ticks that way,
 * so it ticks by day as "30/09" and leaves Recharts to space them.
 */
const MONTH_TICKS_FROM = 3;

export function dateAxisProps(
  points: readonly { readonly date: string }[],
): Pick<XAxisProps, 'ticks' | 'tickFormatter'> {
  const ticks: string[] = [];
  for (const { date } of points) {
    if (ticks.at(-1)?.slice(0, 7) !== date.slice(0, 7)) ticks.push(date);
  }
  return ticks.length < MONTH_TICKS_FROM
    ? { tickFormatter: formatAxisDayMonth }
    : { ticks, tickFormatter: formatAxisMonthYear };
}

/**
 * SPEC-022 BR-022-42 — DS-33 for a **monthly** series' `XAxis`: "set", never
 * `2026-09`. The tooltip keeps the month and year (BR-022-38).
 */
export const monthAxisProps = {
  tickFormatter: formatAxisMonth,
} as const satisfies Pick<XAxisProps, 'tickFormatter'>;

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
 * SPEC-022 BR-022-38 — what a point's tooltip reads, formatted **on the server**
 * and carried on the point as `tip`.
 *
 * The coordinates a chart plots are `Number(decimal.toString())` — fine for
 * placing a mark, and a float-derived figure if it were ever printed
 * (AR-06/AR-09). So the tooltip never formats the coordinate: the page formats
 * the exact amount from the `Money` once, with centavos, and the chart renders
 * that string. Built by `chartTip` (`@/app/chart-series`).
 */
export interface ChartTip {
  /** The point's date ("30/09/2026") or month ("setembro de 2026"). */
  readonly when: string;
  /**
   * The exact figure per `dataKey` — or `R$ ••••••` while masked. A key with no
   * figure (a gap, a month not yet elapsed) is absent, and its series is not
   * drawn at that point either.
   */
  readonly figures: Readonly<Partial<Record<string, string>>>;
}

/** `item.payload` is Recharts' `any`; a point without a `tip` reads as none. */
function tipOf(row: unknown): ChartTip | undefined {
  return (row as { readonly tip?: ChartTip } | null | undefined)?.tip;
}

/**
 * DS-33's tooltip for a chart whose points carry a `tip`: the header is the
 * point's own date and each series reads its server-formatted figure. A
 * chart's only series, given no `name`, reads as the figure alone — Recharts
 * would otherwise print its `dataKey` beside it.
 */
export function chartTipTooltip(masked = false): {
  readonly formatter: NonNullable<TooltipProps<TooltipValueType, string | number>['formatter']>;
  readonly labelFormatter: NonNullable<
    TooltipProps<TooltipValueType, string | number>['labelFormatter']
  >;
} {
  return {
    formatter: (_value, name, item, _index, payload) => {
      const key = String(item.dataKey);
      const figure = masked ? MASKED_CURRENCY : (tipOf(item.payload)?.figures[key] ?? '—');
      const unnamed = payload.length <= 1 && name === key;
      // An `undefined` name drops both the name and its separator.
      return [figure, (unnamed ? undefined : name) as string];
    },
    labelFormatter: (label, payload) => tipOf(payload[0]?.payload)?.when ?? label,
  };
}

/**
 * SPEC-022 BR-022-38 and BR-022-24 — DS-33 for a chart whose value axis is
 * money. Spread `valueAxis` on the `YAxis` and `valueTooltip` on the `Tooltip`,
 * after the shared props:
 *
 * - the axis reads in abbreviated reais ("R$ 250 mil", "R$ 1,2 mi");
 * - the tooltip reads the point's date and its exact amount with centavos, from
 *   the server-formatted `tip` on each point (`ChartTip`);
 * - while masked, every tick and every tooltip figure reads as the same
 *   placeholder `Money` renders, so the axis says "there is a scale here,
 *   hidden" rather than looking empty or broken. Dates and series names stay.
 *
 * `masked` is a **prop of the chart**, passed by the Server Component that
 * also rescaled the chart's coordinates with `concealSeries` — never read from
 * the frame. The frame is a layout, and a client-side navigation does not
 * re-render it, so its idea of the masking can be older than the page's; the
 * labels and the coordinates must come from one render or the axis would print
 * the 0–100 scale as though it were money.
 *
 * The plotted shape stays, as BR-022-24 requires. A chart whose axis is not
 * money — the rebased benchmark lines, the composition ring's shares — does not
 * use this.
 */
export function valueChartProps(masked: boolean): {
  readonly valueAxis: Pick<YAxisProps, 'tickFormatter'>;
  readonly valueTooltip: Pick<
    TooltipProps<TooltipValueType, string | number>,
    'formatter' | 'labelFormatter'
  >;
} {
  return {
    valueAxis: { tickFormatter: masked ? () => MASKED_CURRENCY : formatAxisCurrency },
    valueTooltip: chartTipTooltip(masked),
  };
}

/**
 * DS-10's caveat, applied. `--chart-4` is Okabe–Ito's yellow, which is
 * low-contrast against a light background; every filled mark therefore carries
 * a background-coloured stroke so its edge stays visible in both themes.
 */
export const chartMarkProps = {
  stroke: 'var(--color-background)',
  strokeWidth: 1,
} as const;
