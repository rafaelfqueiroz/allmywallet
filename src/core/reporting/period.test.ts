import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import {
  asOfFor,
  daysInMonth,
  isLeapYear,
  isPeriodKind,
  monthsBefore,
  resolvePeriod,
} from '@/core/reporting/period';
import { ReportingErrorCode } from '@/core/reporting/ports';

/**
 * SPEC-011 BR-011-01 / AC-2: "every period option produces correct date
 * boundaries, including a custom range."
 *
 * TS-04/TS-05: every expectation below is computed by hand and the arithmetic
 * written out. A boundary test asserting what the implementation printed would
 * prove only that the implementation is self-consistent — and a period
 * boundary that is wrong by one day is precisely the defect that ships,
 * looks plausible, and is found by a user reconciling against a broker.
 */

const date = (value: string): BusinessDate => BusinessDate.of(value);

const unwrap = (result: ReturnType<typeof resolvePeriod>) => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
};

describe('isLeapYear (proleptic Gregorian)', () => {
  it('applies all three rules, including the century exceptions', () => {
    // Divisible by 4 → leap.
    expect(isLeapYear(2024)).toBe(true);
    // Not divisible by 4 → common.
    expect(isLeapYear(2023)).toBe(false);
    expect(isLeapYear(2025)).toBe(false);
    // Divisible by 100 but not 400 → common. 1900 was NOT a leap year.
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2100)).toBe(false);
    // Divisible by 400 → leap. 2000 WAS a leap year.
    expect(isLeapYear(2000)).toBe(true);
  });
});

describe('daysInMonth', () => {
  it('returns the length of every month in a common year', () => {
    // Jan..Dec 2025 (2025 is not a leap year).
    const lengths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => daysInMonth(2025, m));
    expect(lengths).toEqual([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
  });

  it('returns 29 for February in a leap year', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
  });
});

describe('monthsBefore', () => {
  it('subtracts whole years without clamping when the day exists', () => {
    // 2026×12 + (8−1) − 12 = 24312 + 7 − 12 = 24307
    // year  = floor(24307 / 12) = 2025   (2025×12 = 24300)
    // month = 24307 − 24300 + 1 = 8
    // day   = min(14, 31) = 14
    expect(monthsBefore(date('2026-08-14'), 12)).toBe('2025-08-14');

    // 24 months from the same anchor: 24312 + 7 − 24 = 24295
    // year  = floor(24295 / 12) = 2024   (2024×12 = 24288)
    // month = 24295 − 24288 + 1 = 8
    expect(monthsBefore(date('2026-08-14'), 24)).toBe('2024-08-14');
  });

  it('clamps 29 February to 28 February when the target year is not a leap year', () => {
    // THE case this function exists for. 12 months before 2024-02-29:
    // 2024×12 + 1 − 12 = 24288 + 1 − 12 = 24277
    // year  = floor(24277 / 12) = 2023   (2023×12 = 24276)
    // month = 24277 − 24276 + 1 = 2
    // day   = min(29, daysInMonth(2023, 2) = 28) = 28
    expect(monthsBefore(date('2024-02-29'), 12)).toBe('2023-02-28');

    // 24 months: 24288 + 1 − 24 = 24265; floor(24265/12) = 2022 (24264)
    // month = 2, day = min(29, 28) = 28
    expect(monthsBefore(date('2024-02-29'), 24)).toBe('2022-02-28');
  });

  it('does not clamp when the target year is also a leap year', () => {
    // 48 months before 2028-02-29: 2028×12 + 1 − 48 = 24336 + 1 − 48 = 24289
    // year  = floor(24289 / 12) = 2024   (24288)
    // month = 2, day = min(29, daysInMonth(2024, 2) = 29) = 29
    expect(monthsBefore(date('2028-02-29'), 48)).toBe('2024-02-29');
  });

  it('clamps a 31st into a 30-day month for a non-year-multiple offset', () => {
    // 1 month before 2026-07-31: 2026×12 + 6 − 1 = 24312 + 6 − 1 = 24317
    // year = floor(24317/12) = 2026 (24312); month = 24317 − 24312 + 1 = 6
    // day  = min(31, daysInMonth(2026, 6) = 30) = 30
    expect(monthsBefore(date('2026-07-31'), 1)).toBe('2026-06-30');
  });

  it('crosses a year boundary when the offset is not a multiple of 12', () => {
    // 8 months before 2026-03-15: 2026×12 + 2 − 8 = 24312 + 2 − 8 = 24306
    // year = floor(24306/12) = 2025 (24300); month = 24306 − 24300 + 1 = 7
    expect(monthsBefore(date('2026-03-15'), 8)).toBe('2025-07-15');
  });

  it('preserves the last day of a 31-day month across a whole year', () => {
    // 2026-01-31 − 12m: 24312 + 0 − 12 = 24300 → 2025, month 1, day min(31,31)=31
    expect(monthsBefore(date('2026-01-31'), 12)).toBe('2025-01-31');
  });
});

describe('resolvePeriod — BR-011-01 / AC-2', () => {
  const today = date('2026-08-14');

  it('YTD runs from 1 January of the current year to today', () => {
    // Calendar-anchored, not "12 months back": 2026-01-01 → 2026-08-14.
    expect(unwrap(resolvePeriod({ kind: 'ytd' }, today))).toEqual({
      from: '2026-01-01',
      to: '2026-08-14',
    });
  });

  it('YTD on 1 January is a single valid day, not an empty range', () => {
    // from === to. Inclusive bounds make this one day, which is correct on
    // the first of January — not an error, and not an empty report.
    expect(unwrap(resolvePeriod({ kind: 'ytd' }, date('2026-01-01')))).toEqual({
      from: '2026-01-01',
      to: '2026-01-01',
    });
  });

  it('YTD inside a leap year still anchors on 1 January', () => {
    expect(unwrap(resolvePeriod({ kind: 'ytd' }, date('2024-02-29')))).toEqual({
      from: '2024-01-01',
      to: '2024-02-29',
    });
  });

  it('12m runs from the same day one year earlier, inclusive of both ends', () => {
    expect(unwrap(resolvePeriod({ kind: '12m' }, today))).toEqual({
      from: '2025-08-14',
      to: '2026-08-14',
    });
  });

  it('24m runs from the same day two years earlier', () => {
    expect(unwrap(resolvePeriod({ kind: '24m' }, today))).toEqual({
      from: '2024-08-14',
      to: '2026-08-14',
    });
  });

  it('12m and 24m clamp a 29 February anchor onto 28 February', () => {
    expect(unwrap(resolvePeriod({ kind: '12m' }, date('2024-02-29')))).toEqual({
      from: '2023-02-28',
      to: '2024-02-29',
    });
    expect(unwrap(resolvePeriod({ kind: '24m' }, date('2024-02-29')))).toEqual({
      from: '2022-02-28',
      to: '2024-02-29',
    });
  });

  it('all time runs from the earliest date the tenant has data for', () => {
    expect(unwrap(resolvePeriod({ kind: 'all' }, today, date('2019-03-07')))).toEqual({
      from: '2019-03-07',
      to: '2026-08-14',
    });
  });

  it('all time with no data at all collapses to today rather than failing', () => {
    // BR-011-16: an empty portfolio is an explanatory empty state, not an
    // error. The range stays valid so the report can render that state.
    expect(unwrap(resolvePeriod({ kind: 'all' }, today, null))).toEqual({
      from: '2026-08-14',
      to: '2026-08-14',
    });
  });

  it('all time defaults `earliest` to null when the argument is omitted', () => {
    expect(unwrap(resolvePeriod({ kind: 'all' }, today))).toEqual({
      from: '2026-08-14',
      to: '2026-08-14',
    });
  });

  it('a custom range is returned exactly as given', () => {
    expect(
      unwrap(
        resolvePeriod({ kind: 'custom', from: date('2025-02-01'), to: date('2025-02-28') }, today),
      ),
    ).toEqual({ from: '2025-02-01', to: '2025-02-28' });
  });

  it('a single-day custom range is valid', () => {
    expect(
      unwrap(
        resolvePeriod({ kind: 'custom', from: date('2025-06-10'), to: date('2025-06-10') }, today),
      ),
    ).toEqual({ from: '2025-06-10', to: '2025-06-10' });
  });

  it('a custom range typed backwards is refused, never silently swapped', () => {
    // Swapping the ends would answer a question the user did not ask and give
    // them a plausible-looking report for a period they did not choose.
    const result = resolvePeriod(
      { kind: 'custom', from: date('2026-03-01'), to: date('2026-02-01') },
      today,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe(ReportingErrorCode.INVALID_PERIOD_RANGE);
    expect(result.error.context).toEqual({
      kind: 'custom',
      from: '2026-03-01',
      to: '2026-02-01',
    });
  });

  it('all time anchored on a future earliest date fails rather than rendering one day', () => {
    // A position cache holding a future date is a defect. Failing names it;
    // clamping would hide it behind a report that looks fine.
    const result = resolvePeriod({ kind: 'all' }, today, date('2027-01-01'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe(ReportingErrorCode.INVALID_PERIOD_RANGE);
    expect(result.error.context.kind).toBe('all');
  });

  it('resolves without reading the ambient clock — the same inputs give the same bounds', () => {
    // Determinism: `today` is a parameter, so a test run at any wall-clock
    // time produces identical bounds. Two calls, two different "todays".
    expect(unwrap(resolvePeriod({ kind: 'ytd' }, date('2020-05-05')))).toEqual({
      from: '2020-01-01',
      to: '2020-05-05',
    });
    expect(unwrap(resolvePeriod({ kind: 'ytd' }, date('2026-08-14')))).toEqual({
      from: '2026-01-01',
      to: '2026-08-14',
    });
  });
});

describe('asOfFor — the valuation date versus the requested range', () => {
  const today = date('2026-08-14');

  it('uses the range end when it is in the past', () => {
    expect(asOfFor({ from: date('2025-01-01'), to: date('2025-12-31') }, today)).toBe('2025-12-31');
  });

  it('uses the range end when it is exactly today', () => {
    expect(asOfFor({ from: date('2026-01-01'), to: today }, today)).toBe('2026-08-14');
  });

  it('falls back to today when the requested range ends in the future', () => {
    // The requested range is preserved as typed; only the holding valuation
    // date is clamped. There are no positions in the future, and asking for
    // them would render a portfolio worth zero — BR-011-16's misleading zero.
    expect(asOfFor({ from: date('2026-01-01'), to: date('2026-12-31') }, today)).toBe('2026-08-14');
  });
});

describe('isPeriodKind', () => {
  it('accepts exactly the five BR-011-01 options', () => {
    for (const kind of ['ytd', '12m', '24m', 'all', 'custom']) {
      expect(isPeriodKind(kind)).toBe(true);
    }
  });

  it('rejects anything else, including near-misses from a hand-edited URL', () => {
    for (const kind of ['YTD', '12M', '36m', '', 'year', 'all-time']) {
      expect(isPeriodKind(kind)).toBe(false);
    }
  });
});
