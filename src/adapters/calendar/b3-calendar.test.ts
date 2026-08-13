import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { B3TradingCalendar } from './b3-calendar';

/**
 * AR-18 / BR-008-06: the trading-calendar check lives in the handler because
 * cron cannot express B3 holidays or half-sessions. That makes this adapter the
 * thing standing between the scheduler and a month's worth of wasted requests
 * against a 15,000-call ceiling — and the free tier has no allowance for a
 * calendar that quietly says "yes" on Carnaval.
 *
 * Every expected value here is a real B3 date, not a value read back from the
 * implementation (TS-04).
 */
const calendar = new B3TradingCalendar();
const on = (date: string) => BusinessDate.of(date);

describe('B3TradingCalendar — trading days', () => {
  it('trades on an ordinary weekday', () => {
    // 2026-03-16 is a Monday with no holiday.
    expect(calendar.isTradingDay(on('2026-03-16'))).toBe(true);
  });

  it('does not trade at the weekend', () => {
    expect(calendar.isTradingDay(on('2026-03-14'))).toBe(false); // Saturday
    expect(calendar.isTradingDay(on('2026-03-15'))).toBe(false); // Sunday
  });

  it('does not trade on the B3 holidays that are not public-holiday obvious', () => {
    // Carnaval spans two days and is the one most likely to be missed by a
    // calendar borrowed from another market.
    expect(calendar.isTradingDay(on('2026-02-16'))).toBe(false);
    expect(calendar.isTradingDay(on('2026-02-17'))).toBe(false);
    // Corpus Christi is a B3 holiday and not a weekend.
    expect(calendar.isTradingDay(on('2026-06-04'))).toBe(false);
  });

  it('computes the weekday independently of the host timezone', () => {
    // `new Date('2026-03-14').getDay()` is timezone-dependent and would report
    // Friday west of UTC. Date.UTC is what keeps this stable on a CI runner in
    // a different zone from São Paulo.
    expect(calendar.isTradingDay(on('2026-03-14'))).toBe(false);
  });
});

describe('B3TradingCalendar — sessions', () => {
  it('opens 10:00 and closes 17:00 São Paulo on a regular day', () => {
    const session = calendar.sessionFor(on('2026-03-16'));
    expect(session).toBeDefined();
    // Brazil has observed no DST since 2019, so São Paulo is a fixed UTC-3:
    // 10:00 local is 13:00Z, 17:00 local is 20:00Z.
    expect(session?.openUtc.toISOString()).toBe('2026-03-16T13:00:00.000Z');
    expect(session?.closeUtc.toISOString()).toBe('2026-03-16T20:00:00.000Z');
    expect(session?.isHalfSession).toBe(false);
  });

  it('closes early on a half-session, and still opens at the regular time', () => {
    // Christmas Eve: opens 10:00, closes 13:00 local (16:00Z).
    const session = calendar.sessionFor(on('2026-12-24'));
    expect(session?.isHalfSession).toBe(true);
    expect(session?.openUtc.toISOString()).toBe('2026-12-24T13:00:00.000Z');
    expect(session?.closeUtc.toISOString()).toBe('2026-12-24T16:00:00.000Z');
  });

  it('has no session at all on a non-trading day', () => {
    expect(calendar.sessionFor(on('2026-02-16'))).toBeUndefined();
    expect(calendar.sessionFor(on('2026-03-15'))).toBeUndefined();
  });
});

describe('B3TradingCalendar — isSessionOpen', () => {
  it('is closed before the open and open at the open', () => {
    // The boundary is inclusive at the open: a poll scheduled exactly at 10:00
    // local must be allowed, or the first bar of the day is never captured.
    expect(calendar.isSessionOpen(new Date('2026-03-16T12:59:59Z'))).toBe(false);
    expect(calendar.isSessionOpen(new Date('2026-03-16T13:00:00Z'))).toBe(true);
  });

  it('is open during the session and closed at the close', () => {
    expect(calendar.isSessionOpen(new Date('2026-03-16T16:30:00Z'))).toBe(true);
    // Exclusive at the close: 17:00 local is no longer a session instant, which
    // is what stops a 17:00 poll spending budget on a market that just shut.
    expect(calendar.isSessionOpen(new Date('2026-03-16T20:00:00Z'))).toBe(false);
    expect(calendar.isSessionOpen(new Date('2026-03-16T20:00:01Z'))).toBe(false);
  });

  it('is closed all day on a holiday, including during regular session hours', () => {
    expect(calendar.isSessionOpen(new Date('2026-02-16T16:00:00Z'))).toBe(false);
  });

  it('closes at 13:00 local on a half-session', () => {
    expect(calendar.isSessionOpen(new Date('2026-12-24T15:59:00Z'))).toBe(true);
    expect(calendar.isSessionOpen(new Date('2026-12-24T16:00:00Z'))).toBe(false);
  });

  it('reads the date in São Paulo, not UTC', () => {
    // 2026-03-17T02:00Z is still 23:00 on the 16th in São Paulo. The market is
    // shut either way, but the *date* it resolves to decides which session is
    // consulted — and getting that wrong shifts every boundary by a day.
    expect(calendar.isSessionOpen(new Date('2026-03-17T02:00:00Z'))).toBe(false);
  });
});

describe('B3TradingCalendar — budget arithmetic inputs', () => {
  it('reports a seven-hour regular session in minutes', () => {
    // 10:00–17:00 = 420 minutes. This feeds the cadence/budget calculation, so
    // an error here silently misprices the whole month's request plan.
    expect(calendar.regularSessionMinutes()).toBe(420);
  });

  it('counts trading days in a month, excluding weekends and holidays', () => {
    // February 2026: 28 days. Weekends: 1,7,8,14,15,21,22,28 = 8 days.
    // Holidays on weekdays: 16 and 17 (Carnaval). 28 − 8 − 2 = 18.
    expect(calendar.tradingDaysInMonth('2026-02')).toBe(18);
  });

  it('counts a month whose holidays fall at the edges', () => {
    // January 2026: 31 days. Weekends: 3,4,10,11,17,18,24,25,31 = 9 days.
    // 1 January is a Thursday holiday. 31 − 9 − 1 = 21.
    expect(calendar.tradingDaysInMonth('2026-01')).toBe(21);
  });

  it('handles a 31-day month with no weekday holidays', () => {
    // March 2026: 31 days. Weekends: 1,7,8,14,15,21,22,28,29 = 9. No holidays.
    expect(calendar.tradingDaysInMonth('2026-03')).toBe(22);
  });
});
