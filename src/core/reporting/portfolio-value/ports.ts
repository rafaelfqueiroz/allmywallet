import type { BusinessDate } from '@/core/shared/clock';
import type { Money } from '@/core/shared/money';
import type { Grouping } from '@/core/reporting/ports';

/**
 * SPEC-013 — the Portfolio Value report's domain types.
 *
 * The report answers *how much do I have, and where did the growth come from?*
 * — and the second half is the whole reason it exists. A portfolio that grew
 * from R$100k to R$150k says nothing until you know whether that was R$50k of
 * deposits or R$50k of returns. Those are opposite facts about how the year
 * went (DL-013-02).
 */

/** BR-013-01 — daily for short ranges, rolled up for long ones. */
export const GRANULARITIES = ['daily', 'weekly', 'monthly'] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/**
 * One point on the value line.
 *
 * `estimated` rides on every point rather than being reported once for the
 * series (BR-013-07, DL-013-04). For a fixed-income-heavy portfolio a large
 * share of the line is accrued rather than observed, and a footnote is read
 * once while the chart is looked at daily.
 */
export interface ValuePoint {
  readonly date: BusinessDate;
  readonly value: Money;
  readonly estimated: boolean;
}

/**
 * BR-013-02/03 — growth, split into the three drivers that caused it.
 *
 * `closing − opening = netContributions + priceChange + earnings`, and it
 * holds *by construction*: `priceChange` is defined as the residual, not
 * computed independently and then checked. See `decomposition.ts` for why that
 * is the honest arrangement rather than a shortcut, and where the real risk
 * moves to as a result.
 */
export interface GrowthDecomposition {
  readonly opening: Money;
  readonly closing: Money;
  /** BR-013-08 — buys and transfers in, less sells and transfers out. Never price, never earnings. */
  readonly netContributions: Money;
  /** The residual. Everything the market did, once flows and income are removed. */
  readonly priceChange: Money;
  /** BR-013-09 — recognised at pay date, consistent with SPEC-012 BR-012-06. */
  readonly earnings: Money;
}

/** BR-013-04 — the figures above the chart. */
export interface HeadlineFigures {
  readonly currentValue: Money;
  /** Net contributions to date: what the user actually put in and left in. */
  readonly totalInvested: Money;
  readonly absoluteGain: Money;
  /**
   * Gain as a **fraction** of what was invested — `0.25`, not `25`. The ×100
   * belongs to the display layer (`formatPercent`), for the same reason AR-09
   * puts rounding there: a domain that pre-scales for one renderer has decided
   * how it will be read.
   *
   * `null` when `totalInvested` is zero or negative — a gain on nothing
   * invested is not a large number, it is an undefined one, and rendering
   * `Infinity%` next to somebody's *patrimônio* is worse than rendering
   * nothing. The UI shows an em dash.
   */
  readonly gainRatio: Money | null;
}

/** BR-013-06 — one bar per month, negative in a month of net withdrawals. */
export interface MonthlyContribution {
  /** `YYYY-MM`. Not a `BusinessDate`: a month is not a day, and typing it as one invites off-by-one bugs at boundaries. */
  readonly month: string;
  readonly amount: Money;
}

/**
 * BR-013-05 — value split by the selected grouping, as bands under the total
 * line.
 *
 * Available for `asset_class` and nothing else, because
 * `daily_valuation_snapshots.by_asset_class` is the only historical breakdown
 * the system stores. The others are not omitted quietly: `unavailable` names
 * the dimension that is missing, so the UI can say why rather than render an
 * empty chart that reads as "you held nothing".
 */
export type StackedSeries =
  | {
      readonly kind: 'available';
      readonly grouping: Grouping;
      readonly bands: readonly StackedBand[];
    }
  | {
      readonly kind: 'unavailable';
      readonly grouping: Grouping;
      readonly reason: StackedSeriesUnavailable;
    };

export interface StackedBand {
  readonly key: string;
  readonly points: readonly ValuePoint[];
}

export const StackedSeriesUnavailable = {
  /**
   * The snapshot carries a per-asset-class breakdown and nothing else. A
   * wallet, institution, sector or per-asset band would need a historical
   * breakdown along that dimension, which is a schema change with rebuild
   * implications rather than a query.
   */
  NO_HISTORICAL_BREAKDOWN: 'NO_HISTORICAL_BREAKDOWN',
} as const;
export type StackedSeriesUnavailable =
  (typeof StackedSeriesUnavailable)[keyof typeof StackedSeriesUnavailable];

/** BR-013-13 — both dates are shown, because they answer different questions. */
export interface Freshness {
  /** The date the figures are valued at. */
  readonly valuationAsOf: BusinessDate;
  /**
   * SPEC-005 BR-005-27 — when custody data was last imported. `null` before
   * the first import. A portfolio value computed from a three-month-old
   * extract is not wrong, but it is answering a question about three months
   * ago, and only this date reveals that.
   */
  readonly lastImportAt: BusinessDate | null;
}

export interface PortfolioValueReport {
  readonly granularity: Granularity;
  readonly series: readonly ValuePoint[];
  readonly decomposition: GrowthDecomposition;
  readonly headline: HeadlineFigures;
  readonly monthlyContributions: readonly MonthlyContribution[];
  readonly stacked: StackedSeries;
  readonly freshness: Freshness;
}
