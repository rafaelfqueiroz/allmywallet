import { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, WalletId } from '@/core/shared/ids';
import { sumMoney, type Money } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import type { Granularity } from '@/core/reporting/portfolio-value/ports';
import { granularityFor, monthOf, weekOf } from '@/core/reporting/portfolio-value/series';
import { reachedAmount } from '@/core/goals/achievement';
import { GoalErrorCode, goalError } from '@/core/goals/errors';
import type { GrowthBasis, WalletGoal } from '@/core/goals/goal';
import { GrowthUnavailable } from '@/core/goals/ports';
import type { GoalAllocationEvent, WalletHolding, WalletValuationPort } from '@/core/goals/ports';

/**
 * Re-exported because both belong to the burn-up's vocabulary and every caller
 * reads them from here; they are *declared* on the port because the port is
 * what decides an unavailable point — see `GrowthUnavailable`.
 */
export { GrowthUnavailable };
export type { WalletHolding };

/**
 * SPEC-019 BR-019-09..13 — the growth burn-up.
 *
 * **There is no pace line and no projection here, and there is no field below
 * a renderer could draw one from** (BR-019-10, DL-019-01). A goal has an
 * amount and no target date, so there is no schedule to be ahead of or behind;
 * a line implying one would be this module inventing a commitment the user
 * never made. The chart is the real line and a flat goal line, and that is the
 * whole shape.
 *
 * **BR-019-13 / DL-019-04 — the series is not year-scoped and does not reset
 * in January.** Only the earnings chart takes a year. A growth series that
 * restarted each year would restart the burn-up against an unchanged
 * multi-year amount, so a R$ 500.000 target would be unreachable by
 * construction every 1 January.
 *
 * **Why this is derived on read rather than read from a snapshot.**
 * `daily_valuation_snapshots` holds one row per user per day with **no wallet
 * dimension** (ADR-002, and `HistoryUnavailable.WALLET_SCOPE_NOT_SNAPSHOTTED`),
 * and issue #50 — which would have added one — was closed NOT_PLANNED. So
 * BR-019-10's "the real line from daily valuation snapshots" is not literally
 * implementable, and the wallet's own series is folded from
 * `wallet_allocation_events` instead: the effective-dated allocation log
 * SPEC-014 introduced for exactly this class of question. Sampling at the
 * chart's own granularity rather than daily is what makes deriving on read
 * affordable — roughly sixty points over five years, not eighteen hundred.
 *
 * Events must arrive **oldest-first**; the port guarantees it, and relying on
 * the query's ordering rather than re-sorting here keeps one definition of
 * which of two changes on the same day came second (`created_at`) — the same
 * contract `core/reporting/earnings/attribution.ts` works under.
 */

/** Long ranges roll up, so a five-year burn-up is not eighteen hundred points. */
const MS_PER_DAY = 86_400_000;

/**
 * One point on the burn-up's real line.
 *
 * A discriminated union rather than a nullable value, so a renderer has to
 * decide what to draw for a date with no figure instead of formatting an
 * absence into `R$ 0,00`.
 */
export type GrowthPoint =
  | {
      readonly kind: 'available';
      readonly date: BusinessDate;
      readonly value: Money;
      /**
       * BR-019-12 / CR-1 — accrued fixed income is computed, not observed.
       * Always false on the `invested` basis: a cost basis is a recorded
       * fact, never an accrual.
       */
      readonly estimated: boolean;
    }
  | {
      readonly kind: 'unavailable';
      readonly date: BusinessDate;
      readonly reason: GrowthUnavailable;
    };

export interface GrowthProgress {
  readonly basis: GrowthBasis;
  readonly goalAmount: Money;
  /**
   * The series' last point — the figure the goal is measured against.
   * `null` only when the wallet has no allocation history at all, in which
   * case there is no line and no progress, rather than a progress of zero.
   */
  readonly current: GrowthPoint | null;
  /**
   * `current ÷ goalAmount`, as a **fraction** — `0.55`, never `55`. AR-09 puts
   * the ×100 and the rounding at display, exactly as `InvestedFigures.gainRatio`
   * does. `null` when the goal is not a usable denominator, or when the
   * current point carries no figure to divide.
   */
  readonly ratio: Money | null;
  readonly series: readonly GrowthPoint[];
  /** True when **any** point on the line is partly accrued (BR-013-07's reasoning, BR-019-12's rule). */
  readonly estimated: boolean;
  /** BR-019-23 — the current figure reaches or exceeds the amount. */
  readonly achieved: boolean;
  /**
   * BR-019-24 — **the first sampled date the line reached the amount**, which
   * is the date the goal was achieved, not the date this was computed.
   *
   * Resolved at the series' own granularity: on a five-year burn-up the
   * points are month-ends, so this names the month, not the afternoon. That
   * is the honest precision — the underlying series is sampled, and inventing
   * a finer date would claim knowledge the fold does not have.
   *
   * `null` when the line never reached it. Independent of `achieved`, which is
   * about the *current* point: a goal crossed in 2023 and since fallen back
   * has a date here and `achieved: false` (BR-019-26).
   */
  readonly achievedOn: BusinessDate | null;
}

/**
 * BR-019-09 — the wallet's holdings on a date: for each `(wallet, asset)`, the
 * latest event at or before it, taking the quantity *after* that change.
 *
 * The same last-value-per-key fold `allocationAt` performs in
 * `core/reporting/earnings/attribution.ts` — no arithmetic, so no way for the
 * fold to drift from the log — with one deliberate difference. Attribution
 * *keeps* a zero, because there a zero is a weight and dropping it would leave
 * the previous quantity standing. Here a zero is dropped, because "this wallet
 * holds none of this asset" contributes nothing to either line, and keeping it
 * would let an asset the wallet no longer holds — and whose pre-migration cost
 * is therefore `null` — make every later point unavailable for a holding that
 * is not there.
 */
export function walletHoldingsOn(
  events: readonly GoalAllocationEvent[],
  walletId: WalletId,
  date: BusinessDate,
): readonly WalletHolding[] {
  const latest = new Map<AssetId, GoalAllocationEvent>();

  for (const event of events) {
    if (event.walletId !== walletId) continue;
    if (BusinessDate.isAfter(event.effectiveOn, date)) continue;
    latest.set(event.assetId, event);
  }

  const holdings: WalletHolding[] = [];
  for (const event of latest.values()) {
    if (!event.quantity.isPositive()) continue;
    holdings.push({
      assetId: event.assetId,
      quantity: event.quantity,
      costBasisAfter: event.costBasisAfter,
    });
  }
  return holdings;
}

/** BR-019-09 — the wallet's first allocation, which is where the line begins. */
export function firstAllocationDate(
  events: readonly GoalAllocationEvent[],
  walletId: WalletId,
): BusinessDate | null {
  for (const event of events) {
    if (event.walletId === walletId) return event.effectiveOn;
  }
  return null;
}

/**
 * The dates the line is drawn at: the last day of every bucket in the range,
 * plus the range's own end.
 *
 * Granularity and bucketing come from `core/reporting/portfolio-value/series.ts`
 * rather than being re-decided here — SPEC-011 DL-011-02 is about exactly this,
 * and a second copy of "when does a chart roll up to weeks" is how two charts
 * of the same wallet end up with different axes. `bucketKey` itself is three
 * lines because the original is module-private; the *thresholds* and the two
 * key functions, which are the parts that could disagree, are imported.
 *
 * The last day of each bucket, because portfolio value is a **stock, not a
 * flow** — a bucket takes its closing figure, never a sum and never a mean.
 */
export function sampleDates(
  from: BusinessDate,
  to: BusinessDate,
  granularity: Granularity,
): readonly BusinessDate[] {
  const samples: BusinessDate[] = [];
  let previous: BusinessDate | null = null;

  for (const day of daysBetween(from, to)) {
    if (previous !== null && bucketKey(day, granularity) !== bucketKey(previous, granularity)) {
      samples.push(previous);
    }
    previous = day;
  }
  if (previous !== null) samples.push(previous);

  return samples;
}

function bucketKey(date: BusinessDate, granularity: Granularity): string {
  if (granularity === 'monthly') return monthOf(date);
  if (granularity === 'weekly') return weekOf(date);
  return date;
}

/**
 * Every calendar day from `from` to `to` inclusive.
 *
 * Stepped in milliseconds from parsed UTC midnights, so the arithmetic is
 * exact and independent of the reader's timezone (AR-29) — a local-time
 * `setDate` walk crosses a DST boundary and silently produces a day twice or
 * not at all.
 */
function* daysBetween(from: BusinessDate, to: BusinessDate): Generator<BusinessDate> {
  const end = Date.parse(to);
  for (let cursor = Date.parse(from); cursor <= end; cursor += MS_PER_DAY) {
    yield BusinessDate.of(new Date(cursor).toISOString().slice(0, 10));
  }
}

/**
 * BR-019-11 — the invested line: the wallet's accumulated cost of the shares
 * it holds on the date.
 *
 * "Cumulative, never resetting" (BR-019-09) is about the chart's **span** — it
 * runs from the first allocation and never restarts at a year boundary — not
 * about forcing the figure upward. A wallet that sold everything has a cost of
 * zero on that date, and drawing it as anything else would state that money is
 * still invested there.
 *
 * Worked example. A wallet allocated PETR4 on 10/01 at a cost of R$ 2.500,00,
 * added HGLG11 on 05/02 at R$ 1.500,00, then bought more PETR4 on 02/03
 * taking its PETR4 cost to R$ 4.000,00:
 *
 *   10/01 → 2.500,00                 (PETR4 alone)
 *   05/02 → 2.500,00 + 1.500,00 = 4.000,00
 *   02/03 → 4.000,00 + 1.500,00 = 5.500,00
 *
 * The 02/03 figure is *not* 2.500 + 1.500 + 4.000: `cost_basis_after` is the
 * cost **after** the change, a state and not a delta, so the fold takes the
 * latest per asset and adds those. Treating it as a delta is the mistake this
 * example exists to make visible six months from now.
 */
export function investedSeries(
  events: readonly GoalAllocationEvent[],
  walletId: WalletId,
  asOf: BusinessDate,
): readonly GrowthPoint[] {
  return seriesFor(events, walletId, asOf, (holdings, date) => {
    const invested = investedOn(holdings);
    return invested === null
      ? { kind: 'unavailable', date, reason: GrowthUnavailable.COST_BASIS_NOT_RECORDED }
      : { kind: 'available', date, value: invested, estimated: false };
  });
}

function investedOn(holdings: readonly WalletHolding[]): Money | null {
  const costs: Money[] = [];
  for (const holding of holdings) {
    if (holding.costBasisAfter === null) return null;
    costs.push(holding.costBasisAfter);
  }
  // `sumMoney([])` is zero, which is the right answer for a wallet that holds
  // nothing on this date — it has nothing invested, not nothing known.
  return sumMoney(costs);
}

/**
 * BR-019-12 — the current-value line: the wallet's market value on each
 * sampled date, with accrued fixed income marked estimated (CR-1).
 *
 * The pricing is the port's, never this module's — see `WalletValuationPort`.
 * The wallet's holdings go across as they are, carrying the **wallet's** own
 * `cost_basis_after` rather than the position's average: BR-010-22 exists to
 * record that distinction, and pricing a wallet holding a tenth of a position
 * at the whole position's cost basis would accrue on nine tenths of somebody
 * else's money.
 *
 * A `null` cost crosses the seam too, undecided. Whether it makes the point
 * unpriceable depends on the asset's **class**, which only the adapter knows —
 * see `GrowthUnavailable.COST_BASIS_NOT_RECORDED` for why refusing every class
 * alike would put this line at odds with SPEC-013's Portfolio Value.
 */
export async function currentValueSeries(
  valuation: WalletValuationPort,
  events: readonly GoalAllocationEvent[],
  walletId: WalletId,
  asOf: BusinessDate,
): Promise<Result<readonly GrowthPoint[], DomainError>> {
  const dates = sampledDatesFor(events, walletId, asOf);
  const points: GrowthPoint[] = [];

  for (const date of dates) {
    const valued = await valuation.valueOn(walletHoldingsOn(events, walletId, date), date);
    // A valuation failure is a fault about the whole request — an asset the
    // catalog does not describe — not a gap in this one point, and it is
    // propagated unchanged so the caller keeps the asset id that caused it.
    if (!valued.ok) return valued;

    points.push(
      valued.value.kind === 'valued'
        ? { kind: 'available', date, value: valued.value.value, estimated: valued.value.estimated }
        : { kind: 'unavailable', date, reason: valued.value.reason },
    );
  }

  return ok(points);
}

/**
 * BR-019-09..13 — the assembled burn-up for one growth goal.
 *
 * Returns a `Result` rather than throwing on a goal of the wrong kind: this is
 * the seam a route calls with a goal it read by id, and a thrown fault there
 * takes out the page instead of one card.
 */
export async function growthProgress(
  valuation: WalletValuationPort,
  goal: WalletGoal,
  events: readonly GoalAllocationEvent[],
  asOf: BusinessDate,
): Promise<Result<GrowthProgress, DomainError>> {
  const basis = goal.basis;
  if (goal.kind !== 'growth' || basis === null) {
    return err(goalError(GoalErrorCode.NOT_A_GROWTH_GOAL, { goalId: goal.id, kind: goal.kind }));
  }

  let series: readonly GrowthPoint[];
  if (basis === 'invested') {
    series = investedSeries(events, goal.walletId, asOf);
  } else {
    const valued = await currentValueSeries(valuation, events, goal.walletId, asOf);
    if (!valued.ok) return valued;
    series = valued.value;
  }

  const current = series.at(-1) ?? null;
  const hasFigure = current !== null && current.kind === 'available';

  return ok({
    basis,
    goalAmount: goal.amount,
    current,
    // A goal amount of zero or less is not a large ratio, it is an undefined
    // one — the same refusal `InvestedFigures.gainRatio` makes, and the reason
    // the UI shows an em dash rather than `Infinity%`.
    ratio:
      hasFigure && goal.amount.isPositive()
        ? current.value.dividedBy(goal.amount.toDecimal())
        : null,
    series,
    estimated: series.some((point) => point.kind === 'available' && point.estimated),
    achieved: hasFigure && reachedAmount(current.value, goal.amount),
    achievedOn: firstCrossing(series, goal.amount),
  });
}

/** Shared by both bases, so the two lines are always drawn at the same dates. */
function sampledDatesFor(
  events: readonly GoalAllocationEvent[],
  walletId: WalletId,
  asOf: BusinessDate,
): readonly BusinessDate[] {
  const first = firstAllocationDate(events, walletId);
  // No allocation ever, or the wallet's history begins after the date asked
  // about: there is no line, which is a different statement from a line at zero.
  if (first === null || BusinessDate.isAfter(first, asOf)) return [];
  return sampleDates(first, asOf, granularityFor(first, asOf));
}

function seriesFor(
  events: readonly GoalAllocationEvent[],
  walletId: WalletId,
  asOf: BusinessDate,
  point: (holdings: readonly WalletHolding[], date: BusinessDate) => GrowthPoint,
): readonly GrowthPoint[] {
  return sampledDatesFor(events, walletId, asOf).map((date) =>
    point(walletHoldingsOn(events, walletId, date), date),
  );
}

/**
 * BR-019-24 — the first point on the line that reached the amount.
 *
 * Scanned forward and stopped at the first match rather than taken from the
 * last: the marker records **when it happened**, and a goal crossed in 2023,
 * dipped under in 2024 and crossed again in 2025 was achieved in 2023
 * (BR-019-26 — the marker is not re-earned).
 *
 * Unavailable points are skipped rather than treated as zero, for the same
 * reason nothing else here reads them as one.
 */
function firstCrossing(series: readonly GrowthPoint[], amount: Money): BusinessDate | null {
  for (const point of series) {
    if (point.kind !== 'available') continue;
    if (reachedAmount(point.value, amount)) return point.date;
  }
  return null;
}
