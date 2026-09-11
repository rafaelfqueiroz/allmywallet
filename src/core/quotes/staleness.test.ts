import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { isQuoteStale, previousTradingDay } from './staleness';

/** SPEC-008 BR-008-15 / DL-008-03. */
describe('isQuoteStale', () => {
  it('outside the session, a stored quote is never stale — however old', () => {
    const now = new Date('2026-03-16T03:00:00Z'); // a Monday pre-open, or a weekend
    const ancient = new Date('2026-01-01T00:00:00Z');
    expect(isQuoteStale(false, 30, now, ancient)).toBe(false);
  });

  it('during the session, a quote older than the cadence interval is stale', () => {
    const now = new Date('2026-03-16T14:00:00Z');
    const fetchedAt = new Date('2026-03-16T13:25:00Z'); // 35 minutes old
    expect(isQuoteStale(true, 30, now, fetchedAt)).toBe(true);
  });

  it('during the session, a quote within the cadence interval is fresh', () => {
    const now = new Date('2026-03-16T14:00:00Z');
    const fetchedAt = new Date('2026-03-16T13:40:00Z'); // 20 minutes old
    expect(isQuoteStale(true, 30, now, fetchedAt)).toBe(false);
  });

  it('exactly at the cadence boundary is not yet stale (strictly greater-than)', () => {
    const now = new Date('2026-03-16T14:00:00Z');
    const fetchedAt = new Date('2026-03-16T13:30:00Z'); // exactly 30 minutes old
    expect(isQuoteStale(true, 30, now, fetchedAt)).toBe(false);
  });
});

describe('previousTradingDay — SPEC-018 BR-018-16, the daily tier floor', () => {
  const weekdaysOnly = (date: BusinessDate): boolean => {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    return day !== 0 && day !== 6;
  };

  it('is yesterday in the middle of a trading week', () => {
    // Tuesday 2026-03-17 → Monday the 16th.
    expect(previousTradingDay(weekdaysOnly, BusinessDate.of('2026-03-17'))).toBe('2026-03-16');
  });

  it('skips the weekend from a Monday', () => {
    // Monday 2026-03-16 → Friday the 13th, not Sunday the 15th.
    expect(previousTradingDay(weekdaysOnly, BusinessDate.of('2026-03-16'))).toBe('2026-03-13');
  });

  it('skips a holiday as readily as a weekend', () => {
    // Carnival: Monday 2026-02-16 and Tuesday the 17th are closed, so
    // Wednesday the 18th looks back past four consecutive closures to Friday
    // the 13th. This is the case a "two days ago" tolerance would get wrong
    // and a calendar gets right for free.
    const carnival = (date: BusinessDate): boolean =>
      weekdaysOnly(date) && date !== '2026-02-16' && date !== '2026-02-17';
    expect(previousTradingDay(carnival, BusinessDate.of('2026-02-18'))).toBe('2026-02-13');
  });

  it('refuses rather than hangs when the calendar reports no trading day at all', () => {
    // A misconfigured calendar dataset. Failing loudly beats looping inside
    // the poll handler.
    expect(() => previousTradingDay(() => false, BusinessDate.of('2026-03-16'))).toThrow(
      /no trading day/,
    );
  });
});
