import { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, WalletId } from '@/core/shared/ids';
import { Money, sumMoney } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import type { EarningRecord } from '@/core/reporting/ports';
import { reachedAmount } from '@/core/goals/achievement';
import { GoalErrorCode, goalError } from '@/core/goals/errors';
import type { EarningsPeriod, WalletGoal } from '@/core/goals/goal';
import type { GoalAllocationEvent } from '@/core/goals/ports';

/**
 * SPEC-019 BR-019-14..22 — the earnings goal's chart: **exactly one calendar
 * year, and nothing outside it.**
 *
 * **The hard constraint is BR-019-19 / DL-019-02**: no series, figure, tooltip
 * or axis value may span a year boundary. Brazilian income is read and
 * declared by calendar year, and a chart that quietly borrowed a month from
 * either side would not reconcile with the informe de rendimentos the same
 * user is holding. The year filter is applied *here*, on the records, rather
 * than trusted from the caller — the caller already filters, and this is the
 * boundary the rule is actually enforced at.
 *
 * **BR-019-14 — this module computes no income of its own.** The records
 * arrive already attributed to the wallet by `attributeAll`
 * (`core/reporting/earnings/attribution.ts`), which is what makes a wallet's
 * income history stable when a holding is later reassigned (BR-014-12).
 * Re-attributing here would be a second answer to a question SPEC-014 already
 * answers.
 *
 * **BR-019-17/18 / DL-019-03 — the average here is deliberately NOT SPEC-014's.**
 * `monthlySeries` in `core/reporting/earnings/received.ts` computes a true
 * twelve-month moving average and refuses to draw it until the window is full.
 * That average reads eleven months of data from outside any single year, which
 * BR-019-19 forbids outright. So this chart carries a **year-to-date average**
 * instead: the mean of the months elapsed *within the selected year*, resetting
 * every January. The accepted cost is that it smooths least in Q1, when the
 * denominator is one, two or three — DL-019-03 takes that deliberately, because
 * a year boundary that leaks is worse than a January that is lumpy. The two
 * screens therefore show different lines over the same data by design, and the
 * field is named `yearToDateAverage` so a renderer cannot label it as the other
 * one (BR-019-18).
 */

const MONTHS_IN_YEAR = 12;

/**
 * One month of the selected year.
 *
 * A discriminated union, because a month that has not happened yet must not
 * carry an amount at all. A fabricated `R$ 0,00` for November when it is March
 * is indistinguishable on a bar chart from a November that genuinely paid
 * nothing, and it would drag the year-to-date average down by nine months of
 * invented zeros. This is the same refusal `MonthlyIncome.movingAverage` makes
 * with its leading nulls, moved into the type so it cannot be forgotten.
 */
export type EarningsMonth =
  | {
      readonly kind: 'elapsed';
      /** `YYYY-MM`. AR-29: a month is not a `BusinessDate` — typing it as a day invites boundary bugs. */
      readonly month: string;
      readonly amount: Money;
      /** BR-019-16 — the running total **within the selected year**, restarting each January. */
      readonly cumulative: Money;
      /** BR-019-17/18 — `cumulative ÷ months elapsed`. January's equals January's income. */
      readonly yearToDateAverage: Money;
    }
  | { readonly kind: 'not_elapsed'; readonly month: string };

/**
 * BR-019-20 — the figure beside the chart, in its two shapes.
 *
 * One field rather than two nullable ones, so a renderer cannot reach a state
 * where both are set or neither is. A closed year has no current month, and
 * showing an empty "this month" box beside a completed year is a question
 * about a month that is not on the chart.
 */
export type EarningsHighlight =
  | { readonly kind: 'current_month'; readonly month: string; readonly amount: Money }
  | { readonly kind: 'year_total'; readonly year: number; readonly amount: Money };

export interface EarningsProgress {
  readonly year: number;
  readonly period: EarningsPeriod;
  /** BR-019-15: a `monthly` goal is a horizontal line across the twelve months. BR-019-16: a `yearly` goal is measured against `cumulative`. */
  readonly goalAmount: Money;
  /** Twelve entries, January to December — or **none at all** when `empty`. */
  readonly months: readonly EarningsMonth[];
  /**
   * The selected year's recorded income. AC — equals the Earnings report's
   * total for the same wallet and year.
   *
   * **May exceed the last elapsed month's `cumulative`**, and deliberately so:
   * a provento dated later in the year counts here, because this figure has to
   * reconcile with SPEC-014 over the same calendar year. `achieved` is
   * measured against the cumulative instead — see `isAchieved`.
   */
  readonly total: Money;
  readonly highlight: EarningsHighlight;
  /** BR-019-21 — no provento was recorded in this year. */
  readonly empty: boolean;
  /** BR-019-23 — reached within the period the goal names. */
  readonly achieved: boolean;
  /**
   * BR-019-24 — **the pay date on which the goal was reached**, not the date
   * this was computed.
   *
   * Exact here, unlike the growth burn-up's month-end sampling: the records
   * carry their own pay dates, so the payment that carried the goal over can
   * be named to the day. `null` when the goal was not reached in this year.
   */
  readonly achievedOn: BusinessDate | null;
}

export function earningsProgress(
  goal: WalletGoal,
  earnings: readonly EarningRecord[],
  year: number,
  asOf: BusinessDate,
): Result<EarningsProgress, DomainError<GoalErrorCode>> {
  const period = goal.period;
  if (goal.kind !== 'earnings' || period === null) {
    return err(goalError(GoalErrorCode.NOT_AN_EARNINGS_GOAL, { goalId: goal.id, kind: goal.kind }));
  }

  // BR-019-19: the boundary, enforced once, on the way in.
  const inYear = earnings.filter((earning) => yearOf(earning.payDate) === year);
  const total = sumMoney(inYear.map((earning) => earning.amount));

  /**
   * BR-019-21 — **an absence of a chart, not a chart of zeros.**
   *
   * Keyed on "no provento was recorded" rather than on a zero total, because
   * the two are different facts: a year that paid nothing and a year whose
   * payments happened to net to zero deserve different sentences. Returning no
   * months at all makes the rule structural — a renderer that ignores `empty`
   * still cannot draw twelve zero bars, because there are none to draw.
   */
  const empty = inYear.length === 0;
  const months = empty ? [] : monthsOf(year, inYear, elapsedMonths(year, asOf));

  return ok({
    year,
    period,
    goalAmount: goal.amount,
    months,
    total,
    highlight: highlightFor(year, inYear, total, asOf),
    empty,
    achieved: isAchieved(period, months, goal.amount),
    achievedOn: crossingDate(period, inYear, elapsedMonths(year, asOf), goal.amount),
  });
}

/**
 * BR-019-22 — the years the selector may offer: those in which the wallet
 * **existed and had allocations**.
 *
 * Derived from the allocation log, never from the income. A year in which the
 * wallet held assets that paid nothing is still a year worth selecting — it is
 * precisely the year BR-019-21's empty state exists to explain, and deriving
 * the list from income would hide it and leave the user unable to ask.
 *
 * Within a year the wallet's holdings change only at event dates, so it held
 * something at some point in year Y exactly when it carried a holding into Y,
 * or some event in Y set a positive quantity. Events arrive oldest-first.
 *
 * Worked example. Allocated on 2023-06-01, emptied on 2023-11-01, allocated
 * again on 2025-02-01, read as of 2026-03-15:
 *
 *   2023 → held (the June allocation)
 *   2024 → entered empty, no events        → **not offered**
 *   2025 → held (the February allocation)
 *   2026 → entered holding the 2025 position
 */
export function goalYears(
  events: readonly GoalAllocationEvent[],
  walletId: WalletId,
  asOf: BusinessDate,
): readonly number[] {
  const mine = events.filter(
    (event) => event.walletId === walletId && !BusinessDate.isAfter(event.effectiveOn, asOf),
  );

  const first = mine[0];
  if (first === undefined) return [];

  const byYear = new Map<number, GoalAllocationEvent[]>();
  for (const event of mine) {
    const bucket = byYear.get(yearOf(event.effectiveOn)) ?? [];
    bucket.push(event);
    byYear.set(yearOf(event.effectiveOn), bucket);
  }

  const held = new Map<AssetId, boolean>();
  const years: number[] = [];

  for (let year = yearOf(first.effectiveOn); year <= yearOf(asOf); year += 1) {
    // Carried in from the previous year — this is what makes a year with no
    // events of its own still count, provided the wallet entered it holding
    // something.
    let anyHeld = [...held.values()].some((positive) => positive);

    for (const event of byYear.get(year) ?? []) {
      held.set(event.assetId, event.quantity.isPositive());
      if (event.quantity.isPositive()) anyHeld = true;
    }

    if (anyHeld) years.push(year);
  }

  return years;
}

/**
 * BR-019-17 — the mean of the months **elapsed within the selected year**.
 *
 * Worked example, a closed year paying R$ 100,00 in January and rising by
 * R$ 100,00 each month to R$ 1.200,00 in December:
 *
 *   January  → 100,00 ÷ 1  = 100,00      (January alone, BR-019-17)
 *   June     → 2.100,00 ÷ 6 = 350,00     (100+200+300+400+500+600)
 *   December → 7.800,00 ÷ 12 = 650,00    (100 × (1+2+…+12) = 100 × 78)
 *
 * The denominator is the month's own ordinal, not the count of months that
 * paid. A mean over "months that paid" is not a monthly income — it is an
 * average payment, and it would rise every time a payer skipped a month.
 */
function monthsOf(
  year: number,
  inYear: readonly EarningRecord[],
  elapsed: number,
): readonly EarningsMonth[] {
  const byMonth = new Map<string, Money>();
  for (const earning of inYear) {
    const key = earning.payDate.slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? Money.zero()).plus(earning.amount));
  }

  const months: EarningsMonth[] = [];
  let cumulative = Money.zero();

  for (let ordinal = 1; ordinal <= MONTHS_IN_YEAR; ordinal += 1) {
    const month = monthKey(year, ordinal);
    if (ordinal > elapsed) {
      months.push({ kind: 'not_elapsed', month });
      continue;
    }

    // A zero here is a real one: an elapsed month that paid nothing, which the
    // chart has to show or an axis jumping from March to July invites the
    // reader to see continuity that is not there.
    const amount = byMonth.get(month) ?? Money.zero();
    cumulative = cumulative.plus(amount);
    months.push({
      kind: 'elapsed',
      month,
      amount,
      cumulative,
      yearToDateAverage: cumulative.dividedBy(String(ordinal)),
    });
  }

  return months;
}

/**
 * How many of the selected year's months have begun, as at `asOf`.
 *
 * The **current** month counts: BR-019-17's "January shows January alone" is a
 * statement about being *in* January, where the average is one month's income
 * so far. A closed year has all twelve; a year that has not started has none,
 * which is what a caller passing a future year gets rather than a chart of
 * twelve invented zeros.
 */
function elapsedMonths(year: number, asOf: BusinessDate): number {
  const asOfYear = yearOf(asOf);
  if (year < asOfYear) return MONTHS_IN_YEAR;
  if (year > asOfYear) return 0;
  return Number(asOf.slice(5, 7));
}

/**
 * BR-019-20 — the current month's income beside the chart, replaced by the
 * year's total when a **closed** year is being viewed.
 */
function highlightFor(
  year: number,
  inYear: readonly EarningRecord[],
  total: Money,
  asOf: BusinessDate,
): EarningsHighlight {
  if (year !== yearOf(asOf)) return { kind: 'year_total', year, amount: total };

  const month = asOf.slice(0, 7);
  const amount = sumMoney(
    inYear.filter((earning) => earning.payDate.slice(0, 7) === month).map((e) => e.amount),
  );
  return { kind: 'current_month', month, amount };
}

/**
 * BR-019-23 — achieved **within the period the goal names**.
 *
 * A monthly goal is reached when any single elapsed month reaches the amount;
 * one good month is the claim a monthly goal makes, and it is not undone by
 * the next one (BR-019-26). A yearly goal is reached when the year's total
 * does — measured against `total`, which is the same figure the Earnings
 * report shows for this wallet and year.
 */
function isAchieved(
  period: EarningsPeriod,
  months: readonly EarningsMonth[],
  amount: Money,
): boolean {
  const elapsed = months.filter(
    (month): month is Extract<EarningsMonth, { kind: 'elapsed' }> => month.kind === 'elapsed',
  );
  if (period === 'yearly') {
    /**
     * **Measured against the last *elapsed* month's cumulative, never against
     * `total`.**
     *
     * `total` sums every provento the ledger records inside the year,
     * including one dated next December — a manual entry with a future pay
     * date is unusual but perfectly enterable, and `total` has to keep
     * counting it or it would stop equalling the Earnings report's figure for
     * the same wallet and year, which is an acceptance criterion.
     *
     * Achievement cannot be measured that way. `achieved` writes a permanent
     * marker (BR-019-26) and sends an email (BR-019-25), and doing either on
     * money that has not arrived would announce an accomplishment against
     * income the user cannot spend. The cumulative of the months that have
     * actually elapsed is what they have received.
     */
    return reachedAmount(elapsed.at(-1)?.cumulative ?? Money.zero(), amount);
  }
  // One good month is the whole claim a monthly goal makes, and BR-019-26
  // means the next month does not undo it.
  return elapsed.some((month) => reachedAmount(month.amount, amount));
}

function yearOf(date: BusinessDate): number {
  return Number(date.slice(0, 4));
}

function monthKey(year: number, ordinal: number): string {
  return `${String(year).padStart(4, '0')}-${String(ordinal).padStart(2, '0')}`;
}

/**
 * BR-019-24 — the pay date at which the goal was carried over its amount.
 *
 * Accumulated over the payments themselves rather than over the monthly folds,
 * because that is the only place the day is recorded: a month's bar says
 * *that* March cleared the goal, the records say it was the payment of the
 * 25th that did it.
 *
 * **Months that have not elapsed are excluded**, exactly as `isAchieved`
 * excludes them — a provento dated next December cannot be what achieved
 * anything today, and this function and that one must never disagree about
 * which payments count.
 */
function crossingDate(
  period: EarningsPeriod,
  inYear: readonly EarningRecord[],
  elapsed: number,
  amount: Money,
): BusinessDate | null {
  const received = [...inYear]
    .filter((earning) => Number(earning.payDate.slice(5, 7)) <= elapsed)
    .sort((a, b) => BusinessDate.compare(a.payDate, b.payDate));

  if (period === 'yearly') {
    let running = Money.zero();
    for (const earning of received) {
      running = running.plus(earning.amount);
      if (reachedAmount(running, amount)) return earning.payDate;
    }
    return null;
  }

  // A monthly goal restarts its accumulation every month — one good month is
  // the claim, so the running total must not carry across the boundary.
  const byMonth = new Map<string, Money>();
  for (const earning of received) {
    const key = earning.payDate.slice(0, 7);
    const running = (byMonth.get(key) ?? Money.zero()).plus(earning.amount);
    byMonth.set(key, running);
    if (reachedAmount(running, amount)) return earning.payDate;
  }
  return null;
}
