import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { B3TradingCalendar } from '@/adapters/calendar/b3-calendar';
import {
  addCalendarDays,
  countBusinessDays,
  earliestOf,
  listBusinessDays,
  listCalendarDays,
} from './business-days';

/**
 * SPEC-009 DL-009-08 — the 252-day convention over the **real** B3 calendar.
 *
 * Deliberately not a `FakeTradingCalendar` with a hand-written holiday set:
 * the thing being tested is that accrual counts the days B3 actually opens,
 * including Carnaval, Sexta-feira Santa and the two December half-sessions.
 * A fake seeded with the answer would assert only that a Set works.
 *
 * Every expected number below is hand-counted in the comment beside it, so a
 * reviewer can check it against a calendar without running anything (TS-05).
 */
const calendar = new B3TradingCalendar();
const d = (value: string): BusinessDate => BusinessDate.of(value);

describe('addCalendarDays', () => {
  it('crosses a month boundary — 2026 is not a leap year, so 28 Feb + 1 = 1 Mar', () => {
    expect(addCalendarDays(d('2026-02-28'), 1)).toBe('2026-03-01');
  });

  it('crosses a year boundary in both directions', () => {
    expect(addCalendarDays(d('2026-12-31'), 1)).toBe('2027-01-01');
    expect(addCalendarDays(d('2026-01-01'), -1)).toBe('2025-12-31');
  });

  it('adding zero days is the identity', () => {
    expect(addCalendarDays(d('2026-03-16'), 0)).toBe('2026-03-16');
  });
});

describe('listCalendarDays (inclusive of both ends)', () => {
  it('16–18 March is three days, weekends included', () => {
    expect(listCalendarDays(d('2026-03-16'), d('2026-03-18'))).toEqual([
      '2026-03-16',
      '2026-03-17',
      '2026-03-18',
    ]);
  });

  it('a single-day range yields that day', () => {
    expect(listCalendarDays(d('2026-03-16'), d('2026-03-16'))).toEqual(['2026-03-16']);
  });

  it('an inverted range yields nothing rather than looping', () => {
    expect(listCalendarDays(d('2026-03-18'), d('2026-03-16'))).toEqual([]);
  });
});

describe('countBusinessDays — the [from, toExclusive) convention (DL-009-08)', () => {
  /**
   * The two boundary cases the convention exists to get right. A CDB issued
   * and valued the same day has earned nothing; issued Monday and valued
   * Tuesday it has earned exactly one day — Monday's rate, which is the rate
   * that was in force while the money was invested.
   */
  it('same day is zero business days — an instrument is worth its principal on day one', () => {
    expect(countBusinessDays(calendar, d('2026-03-16'), d('2026-03-16'))).toBe(0);
  });

  it('Monday to Tuesday is one business day, not two', () => {
    expect(countBusinessDays(calendar, d('2026-03-16'), d('2026-03-17'))).toBe(1);
  });

  it('an inverted window is zero, never negative', () => {
    expect(countBusinessDays(calendar, d('2026-03-20'), d('2026-03-16'))).toBe(0);
  });

  it('skips the weekend: Friday to the following Monday is one business day', () => {
    // 2026-03-20 is a Friday. [20 Mar, 23 Mar) = Fri 20 only — Sat 21 and
    // Sun 22 are not trading days.
    expect(countBusinessDays(calendar, d('2026-03-20'), d('2026-03-23'))).toBe(1);
  });

  it('excludes Carnaval — a holiday B3 observes and a naive weekday count does not', () => {
    // [13 Feb, 20 Feb) 2026:
    //   Fri 13  ✔
    //   Sat 14, Sun 15  ✘ weekend
    //   Mon 16, Tue 17  ✘ Carnaval
    //   Wed 18, Thu 19  ✔
    // = 3 business days. A plain Mon–Fri count would say 5.
    expect(countBusinessDays(calendar, d('2026-02-13'), d('2026-02-20'))).toBe(3);
  });

  it('excludes Sexta-feira Santa and Tiradentes across a 31-day accrual window', () => {
    // The window used by the prefixado worked example in accrual.ts.
    //   16–31 Mar: 16,17,18,19,20, 23,24,25,26,27, 30,31            = 12
    //   1–29  Apr: 1,2, 6,7,8,9,10, 13,14,15,16,17, 20,22,23,24,
    //              27,28,29                                          = 19
    //     (3 Apr Sexta-feira Santa and 21 Apr Tiradentes are closed.)
    //   30 Apr itself is excluded by the half-open convention.
    expect(countBusinessDays(calendar, d('2026-03-16'), d('2026-04-30'))).toBe(31);
  });

  it('counts a half-session as a whole business day — the market opened (24 and 31 December)', () => {
    // [21 Dec 2026, 1 Jan 2027):
    //   Mon 21, Tue 22, Wed 23  ✔
    //   Thu 24  ✔ half-session — B3 opens, closing at 13:00, so interest accrues
    //   Fri 25  ✘ Natal
    //   Sat 26, Sun 27  ✘ weekend
    //   Mon 28, Tue 29, Wed 30  ✔
    //   Thu 31  ✔ half-session
    // = 8 business days.
    expect(countBusinessDays(calendar, d('2026-12-21'), d('2027-01-01'))).toBe(8);
  });

  it('agrees with the calendar’s own month count for February 2026', () => {
    // February 2026 begins on a Sunday: 28 days = 4 Saturdays + 4 Sundays +
    // 20 weekdays, less Carnaval Monday and Tuesday = 18. Cross-checking the
    // two independent implementations (this counter and the calendar
    // adapter's `tradingDaysInMonth`) is what would catch one of them
    // drifting from the shared holiday dataset.
    expect(countBusinessDays(calendar, d('2026-02-01'), d('2026-03-01'))).toBe(18);
    expect(calendar.tradingDaysInMonth('2026-02')).toBe(18);
  });

  it('agrees with the calendar for December 2026, the month with both half-sessions', () => {
    // 31 days from Tue 1 Dec: 8 weekend days, 23 weekdays, less Natal (Fri
    // 25) = 22. Both half-sessions count.
    expect(countBusinessDays(calendar, d('2026-12-01'), d('2027-01-01'))).toBe(22);
    expect(calendar.tradingDaysInMonth('2026-12')).toBe(22);
  });
});

describe('listBusinessDays', () => {
  it('returns the days themselves, in order, so a CDI factor can be drawn per day', () => {
    expect(listBusinessDays(calendar, d('2026-03-16'), d('2026-03-20'))).toEqual([
      '2026-03-16',
      '2026-03-17',
      '2026-03-18',
      '2026-03-19',
    ]);
  });

  it('omits the holiday in the middle of a run rather than shifting it', () => {
    // 1–7 April 2026: Wed 1, Thu 2, [Fri 3 Sexta-feira Santa], Sat 4, Sun 5,
    // Mon 6, Tue 7.
    expect(listBusinessDays(calendar, d('2026-04-01'), d('2026-04-08'))).toEqual([
      '2026-04-01',
      '2026-04-02',
      '2026-04-06',
      '2026-04-07',
    ]);
  });
});

describe('earliestOf (BR-009-15’s accrual cut-off)', () => {
  it('returns the earlier date', () => {
    expect(earliestOf(d('2026-03-16'), d('2026-03-20'))).toBe('2026-03-16');
    expect(earliestOf(d('2026-03-20'), d('2026-03-16'))).toBe('2026-03-16');
  });

  it('returns the shared value when the two are equal', () => {
    expect(earliestOf(d('2026-03-16'), d('2026-03-16'))).toBe('2026-03-16');
  });
});
