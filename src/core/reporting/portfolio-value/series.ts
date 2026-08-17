import type { BusinessDate } from '@/core/shared/clock';
import { Money } from '@/core/shared/money';
import type { AssetClass } from '@/core/quotes/ports';
import type { DailyValuationSnapshot } from '@/core/valuation/ports';
import type { Grouping } from '@/core/reporting/ports';
import {
  HistoryUnavailable,
  type Granularity,
  type MonthlyContribution,
  type StackedBand,
  type StackedSeries,
  type ValuePoint,
} from '@/core/reporting/portfolio-value/ports';

/**
 * SPEC-013 BR-013-01/05/06 — the chart series: the value line, its bands, and
 * the contribution bars.
 *
 * **Portfolio value is a stock, not a flow, so a bucket takes its *last*
 * value — never a sum, never a mean.** Summing daily values would produce a
 * "monthly" figure roughly thirty times the portfolio; averaging would smooth
 * away the month-end figure every other report reconciles against. Net
 * contributions are the opposite: a genuine flow, so a month's bar is the
 * *sum* over the month. Getting these two the wrong way round is the mistake
 * that makes a chart look plausible and be wrong, which is why they live in
 * one file with this note between them.
 */

/** Long ranges roll up, so a five-year chart is not 1,800 daily points. */
const WEEKLY_THRESHOLD_DAYS = 180;
const MONTHLY_THRESHOLD_DAYS = 730;

const MS_PER_DAY = 86_400_000;

/**
 * Compared in milliseconds rather than converted to a day count: both ends
 * parse to UTC midnight, so the difference is an exact multiple of a day and
 * dividing it would only introduce a rounding step AR-09 bars anyway.
 */
export function granularityFor(from: BusinessDate, to: BusinessDate): Granularity {
  const spanMs = Date.parse(to) - Date.parse(from);
  if (spanMs > MONTHLY_THRESHOLD_DAYS * MS_PER_DAY) return 'monthly';
  if (spanMs > WEEKLY_THRESHOLD_DAYS * MS_PER_DAY) return 'weekly';
  return 'daily';
}

/** `YYYY-MM` — the bucket key for a month, and the key `MonthlyContribution` carries. */
export function monthOf(date: BusinessDate): string {
  return date.slice(0, 7);
}

/**
 * The Monday-anchored ISO week a date falls in, keyed by that Monday's date.
 *
 * Keyed by the week's *start* while the bucket takes the week's *last* value:
 * the key is what the axis is labelled with and must be stable and ordered;
 * the value is the point-in-time figure, which is the closing one.
 */
export function weekOf(date: BusinessDate): string {
  const instant = new Date(`${date}T00:00:00Z`);
  // getUTCDay: 0 = Sunday. Shifting by 6 puts Sunday at the end of its week
  // rather than the start of the next one, which is what ISO means by a week.
  const dayOffset = (instant.getUTCDay() + 6) % 7;
  instant.setUTCDate(instant.getUTCDate() - dayOffset);
  return instant.toISOString().slice(0, 10);
}

function bucketKey(date: BusinessDate, granularity: Granularity): string {
  if (granularity === 'monthly') return monthOf(date);
  if (granularity === 'weekly') return weekOf(date);
  return date;
}

/**
 * BR-013-01 — the value line, rolled up to `granularity`.
 *
 * Snapshots arrive ascending, so the last row seen for a bucket *is* that
 * bucket's closing value; no sorting or comparison is needed, and doing either
 * would only introduce a way to disagree with the order the query guaranteed.
 *
 * `estimated` is OR-ed across the bucket rather than taken from the closing
 * row alone. A month containing any accrued figure is a month whose line is
 * partly computed, and marking only the final day would understate that
 * (BR-013-07).
 */
export function valueSeries(
  snapshots: readonly DailyValuationSnapshot[],
  granularity: Granularity,
): readonly ValuePoint[] {
  const buckets = new Map<string, ValuePoint>();

  for (const snapshot of snapshots) {
    const key = bucketKey(snapshot.date, granularity);
    const existing = buckets.get(key);
    buckets.set(key, {
      date: snapshot.date,
      value: snapshot.totalValue,
      estimated: (existing?.estimated ?? false) || snapshot.hasEstimates,
    });
  }

  return [...buckets.values()];
}

/**
 * BR-013-10 / DL-013-05 — the live endpoint.
 *
 * Historical points are official closes and must not move; only "now" carries
 * a delayed quote. Without this, a past point would render differently
 * depending on what time of day the page was loaded — the same historical fact
 * shifting under the reader, which destroys confidence in every other figure
 * on the screen.
 *
 * It also satisfies BR-013-12 as a side effect, and that is the important
 * part: the endpoint becomes the *same* figure the Composition report totals,
 * because both are the valued holdings rather than two independent
 * derivations. Two reports disagreeing about how much money someone has is the
 * single most trust-destroying defect this product could ship (DL-013-06).
 */
export function withLiveEndpoint(
  series: readonly ValuePoint[],
  asOf: BusinessDate,
  currentValue: Money,
  currentlyEstimated: boolean,
  today: BusinessDate,
): readonly ValuePoint[] {
  // A report *about* a past date has no "now" to splice in — its endpoint is
  // that date's close, and replacing it with today's valuation would answer a
  // different question than the one asked.
  if (asOf !== today) return series;

  const live: ValuePoint = { date: asOf, value: currentValue, estimated: currentlyEstimated };
  const last = series.at(-1);
  if (last === undefined) return [live];
  // The snapshot for today may not have been built yet, in which case the live
  // point extends the line rather than replacing its last member.
  return last.date === asOf ? [...series.slice(0, -1), live] : [...series, live];
}

/**
 * BR-013-06 — net contribution per month, from the cumulative column.
 *
 * A flow, so each month's bar is that month's *change* in the running total:
 * `netContributions(end of month) − netContributions(end of previous month)`.
 * Negative in a month of net withdrawals, which the spec calls out explicitly
 * because a bar chart that clamps at zero hides exactly the months a user most
 * wants to find.
 *
 * `opening` anchors the first month. Without it the first bar would be the
 * whole cumulative total to date rather than that month's own contribution —
 * an opening balance rendered as a single enormous deposit.
 */
export function monthlyContributions(
  snapshots: readonly DailyValuationSnapshot[],
  opening: DailyValuationSnapshot | null,
): readonly MonthlyContribution[] {
  const closingByMonth = new Map<string, Money>();
  for (const snapshot of snapshots) {
    closingByMonth.set(monthOf(snapshot.date), snapshot.netContributions);
  }

  const bars: MonthlyContribution[] = [];
  let previous = opening?.netContributions ?? Money.zero();
  for (const [month, cumulative] of closingByMonth) {
    bars.push({ month, amount: cumulative.minus(previous) });
    previous = cumulative;
  }
  return bars;
}

/**
 * BR-013-05 — the stacked bands under the total line.
 *
 * Only `asset_class` can be answered: `daily_valuation_snapshots.by_asset_class`
 * is the sole historical breakdown stored. Every other dimension would need a
 * per-day breakdown along it — a schema change with rebuild implications, not
 * a query — so this reports *why* it cannot rather than returning empty bands.
 * An empty chart reads as "you held nothing", which is a false statement about
 * someone's portfolio; a named reason is a true one about the product.
 *
 * The bands sum to the total line by construction: they are the components of
 * the same `total_value` the line is drawn from, not a parallel computation
 * (AC — "its bands sum to the total line").
 */
export function stackedSeries(
  snapshots: readonly DailyValuationSnapshot[],
  granularity: Granularity,
  grouping: Grouping,
): StackedSeries {
  if (grouping !== 'asset_class') {
    return {
      kind: 'unavailable',
      grouping,
      reason: HistoryUnavailable.NO_HISTORICAL_BREAKDOWN,
    };
  }

  const byClass = new Map<AssetClass, Map<string, ValuePoint>>();

  for (const snapshot of snapshots) {
    const key = bucketKey(snapshot.date, granularity);
    for (const [assetClass, value] of snapshot.byAssetClass) {
      const buckets = byClass.get(assetClass) ?? new Map<string, ValuePoint>();
      buckets.set(key, {
        date: snapshot.date,
        value,
        estimated: (buckets.get(key)?.estimated ?? false) || snapshot.hasEstimates,
      });
      byClass.set(assetClass, buckets);
    }
  }

  const bands: StackedBand[] = [...byClass.entries()].map(([assetClass, buckets]) => ({
    key: assetClass,
    points: [...buckets.values()],
  }));

  return { kind: 'available', grouping, bands };
}
