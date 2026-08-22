import { Money, sumMoney } from '@/core/shared/money';
import { EARNING_TYPES, type EarningRecord } from '@/core/reporting/ports';
import type { MonthlyIncome, TypeTotal, YearOverYear } from '@/core/reporting/earnings/ports';

/**
 * SPEC-014 BR-014-01/02/03/07 — what was received, how it was paid, and
 * whether it is growing.
 */

/**
 * BR-014-01/02 — the period's total per type, in a fixed order.
 *
 * Every type is present even at zero. A dividend investor who received no JCP
 * this period is told so; omitting the line would leave them wondering whether
 * the report forgot it, and the two states look identical on screen.
 */
export function totalsByType(earnings: readonly EarningRecord[]): readonly TypeTotal[] {
  // Driven from the type list rather than from the data, which is what makes
  // "every type, including the ones that paid nothing" true by construction
  // rather than by remembering to fill gaps afterwards.
  return EARNING_TYPES.map((type) => ({
    type,
    amount: sumMoney(
      earnings.filter((earning) => earning.type === type).map((earning) => earning.amount),
    ),
  }));
}

export function totalReceived(earnings: readonly EarningRecord[]): Money {
  return sumMoney(earnings.map((earning) => earning.amount));
}

/** The number of months a 12-month average needs before it means anything. */
const MOVING_AVERAGE_WINDOW = 12;

/**
 * BR-014-03 / DL-014-03 — monthly income with a twelve-month trailing average.
 *
 * **Why an average at all.** Brazilian payers are irregular: quarterly,
 * semi-annual, one-off, and FIIs monthly. Raw bars for a portfolio holding both
 * look chaotic, and the chaos hides the only question the chart is asked —
 * whether income is growing. Quarterly aggregation would smooth the bars, but
 * it would also hide the FII rendimentos, which are the smooth part and the
 * part an income investor watches most closely.
 *
 * **Months with no income are present as zero.** A payer that skipped a quarter
 * has to show that gap, and an axis that jumps from March to July invites the
 * reader to see continuity that is not there. It also keeps the average
 * honest: a mean over "months that paid" is not a monthly income.
 *
 * The average is `null` until the window is full. A partial mean rises for
 * arithmetic reasons alone — the denominator growing while months accumulate —
 * and a reader would take a rising line as growth. Refusing to draw it for the
 * first eleven months is the honest option.
 */
export function monthlySeries(
  earnings: readonly EarningRecord[],
  range: { readonly from: string; readonly to: string },
): readonly MonthlyIncome[] {
  const byMonth = new Map<string, Money>();
  for (const month of monthsBetween(range.from.slice(0, 7), range.to.slice(0, 7))) {
    byMonth.set(month, Money.zero());
  }

  for (const earning of earnings) {
    const month = earning.payDate.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? Money.zero()).plus(earning.amount));
  }

  const months = [...byMonth.entries()];

  return months.map(([month, amount], index) => {
    if (index + 1 < MOVING_AVERAGE_WINDOW) return { month, amount, movingAverage: null };

    const window = months.slice(index + 1 - MOVING_AVERAGE_WINDOW, index + 1);
    const total = sumMoney(window.map(([, value]) => value));
    return { month, amount, movingAverage: total.dividedBy(String(MOVING_AVERAGE_WINDOW)) };
  });
}

/** Every `YYYY-MM` from `first` to `last` inclusive, in order. */
function monthsBetween(first: string, last: string): readonly string[] {
  const months: string[] = [];
  const [startYear, startMonth] = first.split('-').map(Number);
  const [endYear, endMonth] = last.split('-').map(Number);
  if (
    startYear === undefined ||
    startMonth === undefined ||
    endYear === undefined ||
    endMonth === undefined
  ) {
    return months;
  }

  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/**
 * BR-014-07 — the period against the equal-length period before it.
 *
 * `null` growth when the previous period produced nothing. "Income grew from
 * zero" has no percentage, and rendering ∞ — or the 100 % a naive guard would
 * produce — states something about division rather than about the portfolio.
 * The two amounts are still reported, so a reader can see the change for
 * themselves.
 */
export function yearOverYear(current: Money, previous: Money): YearOverYear {
  return {
    current,
    previous,
    change: previous.isPositive() ? current.minus(previous).dividedBy(previous.toDecimal()) : null,
  };
}
