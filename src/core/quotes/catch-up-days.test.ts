import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import {
  CLOSE_CAPTURE_CRON,
  closeCaptureInstant,
  enumerateCatchUpDays,
  lastDueCloseDate,
} from './catch-up-days';
import { FakeTradingCalendar } from './test-support';

/**
 * SPEC-021 BR-021-28 — the missed-close window.
 *
 * The calendars below list the real 2026 B3 trading days for each stretch, so
 * a weekend or a holiday is expressed the way the adapter expresses it: by the
 * day being absent. `FakeTradingCalendar` closes every session at 20:00Z
 * (17:00 in São Paulo).
 */
const d = (value: string): BusinessDate => BusinessDate.of(value);

// March 2026: weekdays only; no B3 holiday in the stretch.
const MARCH = new FakeTradingCalendar([
  '2026-03-02',
  '2026-03-03',
  '2026-03-04',
  '2026-03-05',
  '2026-03-06',
  '2026-03-09',
  '2026-03-10',
  '2026-03-11',
  '2026-03-12',
  '2026-03-13',
  '2026-03-16',
  '2026-03-17',
]);

// Carnival 2026: Monday 16 and Tuesday 17 February are B3 holidays.
const CARNIVAL = new FakeTradingCalendar([
  '2026-02-11',
  '2026-02-12',
  '2026-02-13',
  '2026-02-18',
  '2026-02-19',
]);

describe('enumerateCatchUpDays (SPEC-021 BR-021-28)', () => {
  it('three business days down across a weekend: Thu, Fri and Mon, while Tuesday’s session is still open', () => {
    // Last capture Wed 11. Now Tue 17 at 12:00 São Paulo (15:00Z), before the
    // 20:00Z close — so Tuesday is not missed yet.
    //   Thu 12 ✓  Fri 13 ✓  Sat 14 ✗  Sun 15 ✗  Mon 16 ✓  Tue 17 not due
    const result = enumerateCatchUpDays({
      calendar: MARCH,
      now: new Date('2026-03-17T15:00:00Z'),
      today: d('2026-03-17'),
      lastCapturedClose: d('2026-03-11'),
      maxDays: 30,
    });
    expect(result.days).toEqual(['2026-03-12', '2026-03-13', '2026-03-16']);
    expect(result.beyondCap).toBe(0);
  });

  it('skips B3 holidays, and includes today once its 17:05 close capture has passed', () => {
    // Last capture Thu 12 Feb. Now Thu 19 Feb at 18:00 São Paulo (21:00Z),
    // after the 20:05Z capture that a stopped worker missed.
    //   Fri 13 ✓  Sat/Sun ✗  Mon 16 Carnaval ✗  Tue 17 Carnaval ✗  Wed 18 ✓  Thu 19 ✓ (closed)
    const result = enumerateCatchUpDays({
      calendar: CARNIVAL,
      now: new Date('2026-02-19T21:00:00Z'),
      today: d('2026-02-19'),
      lastCapturedClose: d('2026-02-12'),
      maxDays: 30,
    });
    expect(result.days).toEqual(['2026-02-13', '2026-02-18', '2026-02-19']);
  });

  it('keeps the most recent days when the absence is longer than personal.catchup_max_days', () => {
    // Last capture Mon 2 Mar; now Mon 16 Mar 12:00 (session open, 16th not due).
    // Missed: 3, 4, 5, 6, 9, 10, 11, 12, 13 → 9 business days.
    // Cap 5 keeps the last five: 9, 10, 11, 12, 13; 9 − 5 = 4 beyond the cap.
    const result = enumerateCatchUpDays({
      calendar: MARCH,
      now: new Date('2026-03-16T15:00:00Z'),
      today: d('2026-03-16'),
      lastCapturedClose: d('2026-03-02'),
      maxDays: 5,
    });
    expect(result.days).toEqual([
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
    ]);
    expect(result.beyondCap).toBe(4);
  });

  it('no close ever captured: there is no absence to measure, so nothing is missed', () => {
    const result = enumerateCatchUpDays({
      calendar: MARCH,
      now: new Date('2026-03-17T15:00:00Z'),
      today: d('2026-03-17'),
      lastCapturedClose: null,
      maxDays: 30,
    });
    expect(result).toEqual({ days: [], beyondCap: 0 });
  });

  it('a capture already taken for the last due day leaves nothing to do', () => {
    // Yesterday (Mon 16) was captured; today's session is open.
    const result = enumerateCatchUpDays({
      calendar: MARCH,
      now: new Date('2026-03-17T15:00:00Z'),
      today: d('2026-03-17'),
      lastCapturedClose: d('2026-03-16'),
      maxDays: 30,
    });
    expect(result.days).toEqual([]);
  });

  it.each([0, -1, 1.5])(
    'refuses maxDays = %s rather than reporting "nothing missed"',
    (maxDays) => {
      expect(() =>
        enumerateCatchUpDays({
          calendar: MARCH,
          now: new Date('2026-03-17T15:00:00Z'),
          today: d('2026-03-17'),
          lastCapturedClose: d('2026-03-11'),
          maxDays,
        }),
      ).toThrow(RangeError);
    },
  );
});

describe('lastDueCloseDate', () => {
  // quotes.close-capture fires at 17:05 São Paulo = 20:05Z (fixed UTC−3).
  it('is today exactly at the close-capture instant', () => {
    expect(lastDueCloseDate(MARCH, new Date('2026-03-17T20:05:00Z'), d('2026-03-17'))).toBe(
      '2026-03-17',
    );
  });

  it('is yesterday one millisecond before the close-capture instant', () => {
    expect(lastDueCloseDate(MARCH, new Date('2026-03-17T20:04:59.999Z'), d('2026-03-17'))).toBe(
      '2026-03-16',
    );
  });

  it('the race window: at 17:02 the session has closed (17:00) but the 17:05 capture will still run, so today is not missed', () => {
    // 17:02 São Paulo = 20:02Z — after FakeTradingCalendar's 20:00Z close.
    expect(lastDueCloseDate(MARCH, new Date('2026-03-17T20:02:00Z'), d('2026-03-17'))).toBe(
      '2026-03-16',
    );
  });

  it('is yesterday on a day with no session at all, even after 17:00', () => {
    // Saturday 14 March — no session, so no close is ever due on it.
    expect(lastDueCloseDate(MARCH, new Date('2026-03-14T22:00:00Z'), d('2026-03-14'))).toBe(
      '2026-03-13',
    );
  });

  it('crosses a month boundary', () => {
    expect(lastDueCloseDate(MARCH, new Date('2026-03-01T12:00:00Z'), d('2026-03-01'))).toBe(
      '2026-02-28',
    );
  });
});

describe('close-capture schedule — one source for the cron and the window', () => {
  it('the cron expression is 17:05 on weekdays', () => {
    expect(CLOSE_CAPTURE_CRON).toBe('5 17 * * 1-5');
  });

  it('the capture instant is 17:05 São Paulo, i.e. 20:05Z', () => {
    expect(closeCaptureInstant(d('2026-03-17')).toISOString()).toBe('2026-03-17T20:05:00.000Z');
  });
});
