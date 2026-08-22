import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import type { Money } from '@/core/shared/money';
import type { EarningType, GroupKey, Grouping } from '@/core/reporting/ports';

/**
 * SPEC-014 — the Earnings report's shapes.
 *
 * The report answers two questions that look like one: **how much did this
 * pay**, and **is that growing**. Everything here serves the second as much as
 * the first, which is why the monthly series carries a moving average and the
 * totals carry a prior-period comparison rather than standing alone.
 */

/** BR-014-01/02 — one line of the received breakdown, per provento type. */
export interface TypeTotal {
  readonly type: EarningType;
  readonly amount: Money;
}

/**
 * BR-014-03 — one month of income, with the trailing average that makes a
 * lumpy series readable.
 *
 * `movingAverage` is `null` until twelve months of history exist inside the
 * period. A partial average would slope upward from the first month for
 * arithmetic reasons alone — the denominator growing, not the income — and a
 * user reading a rising line would conclude the opposite of the truth.
 */
export interface MonthlyIncome {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly amount: Money;
  readonly movingAverage: Money | null;
}

/** BR-014-04 — one group's income, ranked, with its share of the total. */
export interface IncomeSlice {
  readonly key: GroupKey;
  readonly amount: Money;
  /** `amount ÷ total`, or `null` when the total is zero — never a fabricated 0 %. */
  readonly share: Money | null;
}

/**
 * BR-014-05/06 — per-asset income and the two yields, which are different
 * questions and are never conflated (DL-014-01).
 */
export interface AssetIncome {
  readonly assetId: AssetId;
  readonly assetCode: string;
  readonly assetName: string;
  readonly amount: Money;
  /**
   * BR-014-05 — income received in the period over the cost basis of the
   * position that generated it. The number that answers "is the plan
   * working?": someone who bought at R$ 10 and now receives R$ 1,20 is earning
   * 12 % on their money whatever today's price implies.
   *
   * `null` when the asset is no longer held, or is held at no recorded cost —
   * there is nothing to divide by, and dividing by today's value would quietly
   * turn this into the other yield.
   */
  readonly yieldOnCost: Money | null;
  /**
   * BR-014-06 — trailing twelve months of income over the position's current
   * market value. What a *new* buyer would get, which is what comparisons
   * against other assets need and what yield on cost cannot answer.
   *
   * Always over twelve months regardless of the selected period: a "current
   * yield" computed over a three-month period would read as a quarter of the
   * real one, and a two-year period as double.
   */
  readonly currentYield: Money | null;
}

/**
 * BR-014-07 — the period against the one immediately before it, of equal
 * length.
 *
 * `change` is `null` when the previous period produced nothing: growth from
 * zero is not a percentage, and reporting one (or an infinity) would be a
 * statement about arithmetic rather than about the portfolio.
 */
export interface YearOverYear {
  readonly current: Money;
  readonly previous: Money;
  readonly change: Money | null;
}

/**
 * BR-014-09/10 — announced-but-unpaid income.
 *
 * Only ever `unavailable` in v1, and that is a sourcing fact rather than an
 * empty result: the free quote tier carries no dividend data and B3's Eventos
 * Provisionados API is B2B-only (PRD Q8). The distinction matters on screen —
 * an empty section reads as "you have no upcoming income", which is a claim
 * this product cannot make (DL-014-06).
 */
export type UpcomingIncome =
  | { readonly kind: 'available'; readonly items: readonly UpcomingItem[] }
  | { readonly kind: 'unavailable'; readonly reason: 'NO_FORWARD_LOOKING_SOURCE' };

export interface UpcomingItem {
  readonly assetId: AssetId;
  readonly type: EarningType;
  readonly payDate: BusinessDate;
  readonly amount: Money;
}

export interface EarningsReport {
  readonly grouping: Grouping;
  /** BR-014-01 — the period's total, and the same figure the breakdown sums to. */
  readonly total: Money;
  readonly byType: readonly TypeTotal[];
  readonly monthly: readonly MonthlyIncome[];
  readonly breakdown: readonly IncomeSlice[];
  readonly perAsset: readonly AssetIncome[];
  /** BR-014-05 at scope level: the period's income over the scope's cost basis. */
  readonly yieldOnCost: Money | null;
  readonly growth: YearOverYear;
  readonly upcoming: UpcomingIncome;
  /** BR-011-16 / AC-16: no income in the scope — an explanation, not a zero-filled chart. */
  readonly empty: boolean;
}
