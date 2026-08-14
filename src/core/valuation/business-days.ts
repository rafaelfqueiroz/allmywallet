import { BusinessDate } from '@/core/shared/clock';
import type { TradingCalendar } from '@/core/valuation/ports';

/**
 * SPEC-009 DL-009-08 — the 252-day convention, over the B3 calendar.
 *
 * **Why this file is not a detail.** Brazilian fixed income accrues on
 * business days against a 252-day year, not on calendar days. A calendar-day
 * accrual drifts measurably from the issuer's own figure over a multi-year
 * holding — roughly the ratio 365/252, which is not a rounding difference but
 * a 45% overstatement of elapsed time. Every CDB, LCI and LCA figure the
 * product shows rests on the counting done here.
 *
 * **The interval convention, stated once.** Every function below counts the
 * half-open interval `[from, toExclusive)` — the start date included, the end
 * date excluded. That is the ANBIMA *dias úteis* convention, and it is what
 * makes the two boundary cases come out right:
 *
 *   - a CDB issued and valued on the same day has accrued **zero** days and is
 *     worth exactly its principal;
 *   - a CDB issued Monday and valued Tuesday has accrued **one** day — Monday's
 *     CDI, which is the rate that was in force while the money was invested.
 *
 * The alternative (inclusive of both ends) would credit an instrument with a
 * day of interest on the day it was bought, which no issuer does.
 *
 * AR-01: the calendar arrives as a port, never as a hardcoded holiday list —
 * `src/adapters/calendar/b3-calendar.ts` is the real one, and a half-session
 * (24 and 31 December) is a full business day for accrual purposes because the
 * market opened at all.
 */

const MILLISECONDS_PER_DAY = 86_400_000;

function toUtcMillis(date: BusinessDate): number {
  const [year, month, day] = date.split('-').map((part) => Number(part));
  // BusinessDate.of has already validated the shape and the calendar validity,
  // so the three parts are present; Date.UTC keeps this independent of the
  // host's own timezone, which `new Date('2026-03-16')` arithmetic would not be.
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function fromUtcMillis(millis: number): BusinessDate {
  return BusinessDate.of(new Date(millis).toISOString().slice(0, 10));
}

/**
 * Calendar-day arithmetic, done in UTC milliseconds so no daylight-saving
 * transition anywhere can shift a date by one (AR-29). Brazil observes none
 * today, but the reader of this code should not have to know that.
 */
export function addCalendarDays(date: BusinessDate, days: number): BusinessDate {
  return fromUtcMillis(toUtcMillis(date) + days * MILLISECONDS_PER_DAY);
}

/** Every calendar day in `[from, toInclusive]`. Empty when `toInclusive < from`. */
export function listCalendarDays(
  from: BusinessDate,
  toInclusive: BusinessDate,
): readonly BusinessDate[] {
  const days: BusinessDate[] = [];
  const end = toUtcMillis(toInclusive);
  for (let cursor = toUtcMillis(from); cursor <= end; cursor += MILLISECONDS_PER_DAY) {
    days.push(fromUtcMillis(cursor));
  }
  return days;
}

/**
 * The business days in `[from, toExclusive)` — the days interest actually
 * accrues over, and the days a CDI factor is drawn for.
 */
export function listBusinessDays(
  calendar: TradingCalendar,
  from: BusinessDate,
  toExclusive: BusinessDate,
): readonly BusinessDate[] {
  const days: BusinessDate[] = [];
  const end = toUtcMillis(toExclusive);
  for (let cursor = toUtcMillis(from); cursor < end; cursor += MILLISECONDS_PER_DAY) {
    const date = fromUtcMillis(cursor);
    if (calendar.isTradingDay(date)) days.push(date);
  }
  return days;
}

/**
 * `DU` — the count the 252-day convention divides by.
 *
 * Worked example (DV-17), hand-counted against the B3 calendar so the
 * convention is legible rather than asserted:
 *
 *   `countBusinessDays(cal, 2026-03-16, 2026-04-30)` = **31**
 *     March 16–31 → 16, 17, 18, 19, 20, 23, 24, 25, 26, 27, 30, 31   = 12
 *     April 1–29  → 1, 2, 6, 7, 8, 9, 10, 13, 14, 15, 16, 17,
 *                   20, 22, 23, 24, 27, 28, 29                       = 19
 *     (3 April is Sexta-feira Santa and 21 April Tiradentes — both closed.)
 *     12 + 19 = 31, and 30 April itself is excluded by the convention.
 */
export function countBusinessDays(
  calendar: TradingCalendar,
  from: BusinessDate,
  toExclusive: BusinessDate,
): number {
  return listBusinessDays(calendar, from, toExclusive).length;
}

/**
 * The earlier of two dates. Used for BR-009-15's accrual cut-off: a matured
 * instrument stops accruing at maturity and holds that value until a
 * redemption transaction is recorded, so the window always ends at
 * `min(asOf, maturityDate)`.
 */
export function earliestOf(a: BusinessDate, b: BusinessDate): BusinessDate {
  return BusinessDate.isBefore(a, b) ? a : b;
}
