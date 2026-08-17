import { BusinessDate } from '@/core/shared/clock';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import { err, ok, type Result } from '@/core/shared/result';
import {
  ReportingErrorCode,
  type DateRange,
  type Period,
  type PeriodKind,
} from '@/core/reporting/ports';

/**
 * SPEC-011 BR-011-01 — YTD, 12m, 24m, all time, or a custom range, resolved to
 * concrete date bounds.
 *
 * **AR-29 governs this whole file.** Every value here is a `BusinessDate`, and
 * the arithmetic below is done on the calendar fields directly rather than
 * through `Date`. That is not stylistic: `new Date('2026-01-01')` is midnight
 * **UTC**, which is 2025-12-31 21:00 in São Paulo, so a YTD boundary computed
 * through `Date` lands on the wrong side of the year for every reader in
 * Brazil. The same off-by-one shifts a transaction across a period boundary
 * and quietly changes a *rentabilidade* nobody can explain.
 *
 * Determinism: `today` is a parameter. Nothing in this module reads
 * `Date.now()` — the caller passes `Clock.today()` (AR-03), so the same inputs
 * always produce the same bounds.
 */

interface CalendarDate {
  readonly year: number;
  readonly month: number; // 1–12
  readonly day: number; // 1–31
}

function parts(date: BusinessDate): CalendarDate {
  // `BusinessDate.of` has already proven the shape and the reality of the date
  // (it rejects 2026-02-31), so these three reads cannot be NaN.
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return { year, month, day };
}

function format({ year, month, day }: CalendarDate): BusinessDate {
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return BusinessDate.of(`${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`);
}

/** Proleptic Gregorian, which is what Postgres `date` and ISO-8601 both use. */
export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  // April, June, September, November.
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/**
 * `months` calendar months before `date`, with the day **clamped to the last
 * day of the target month**.
 *
 * The clamp is the only interesting decision here, and it exists because
 * "12 months before 29 February 2024" has no exact answer — 29 February 2023
 * does not exist. Clamping to 28 February 2023 is the convention every
 * financial calendar uses, and the alternative (rolling forward to 1 March)
 * would put the baseline *inside* the period it is supposed to precede.
 *
 * Worked examples, hand-computed:
 *
 *   monthsBefore(2026-08-14, 12)
 *     = 2026×12 + (8−1) − 12 = 24312 + 7 − 12 = 24307 months
 *     → year  = floor(24307 / 12) = 2025      (2025×12 = 24300)
 *     → month = 24307 − 24300 + 1 = 8
 *     → day   = min(14, daysInMonth(2025, 8) = 31) = 14
 *     = 2025-08-14                                    (no clamp)
 *
 *   monthsBefore(2024-02-29, 12)                      ← the leap-year case
 *     = 2024×12 + 1 − 12 = 24288 + 1 − 12 = 24277 months
 *     → year  = floor(24277 / 12) = 2023      (2023×12 = 24276)
 *     → month = 24277 − 24276 + 1 = 2
 *     → day   = min(29, daysInMonth(2023, 2) = 28) = 28
 *     = 2023-02-28                                    (clamped)
 *
 *   monthsBefore(2028-02-29, 48)                      ← leap → leap, no clamp
 *     = 2028×12 + 1 − 48 = 24336 + 1 − 48 = 24289 months
 *     → year  = floor(24289 / 12) = 2024      (2024×12 = 24288)
 *     → month = 24289 − 24288 + 1 = 2
 *     → day   = min(29, daysInMonth(2024, 2) = 29) = 29
 *     = 2024-02-29                                    (no clamp)
 */
export function monthsBefore(date: BusinessDate, months: number): BusinessDate {
  const { year, month, day } = parts(date);
  const totalMonths = year * 12 + (month - 1) - months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = totalMonths - targetYear * 12 + 1;
  return format({
    year: targetYear,
    month: targetMonth,
    day: Math.min(day, daysInMonth(targetYear, targetMonth)),
  });
}

/**
 * BR-011-01 — a period option plus the anchors it needs, resolved to bounds.
 *
 * `earliest` is the first date this tenant has any data for, and only the
 * `all` option reads it. `null` means "no data at all", which resolves to the
 * single day `today` rather than to an error: an empty portfolio is BR-011-16's
 * explanatory empty state, not a failure.
 *
 * Both ends are inclusive: a 12m period on 2026-08-14 runs 2025-08-14 →
 * 2026-08-14 and covers both endpoints.
 *
 * **`from` is the period's first day, not its opening balance**, and the
 * distinction has cost this codebase two defects. A snapshot dated `from` is
 * the *close* of `from` (SPEC-009 replays to and including the date), so a
 * report measuring growth or return from it discards everything that happened
 * during the period's own first day — plausibly, and invisibly. The opening
 * balance is the snapshot **before** `from`, which is why SPEC-013 BR-013-02
 * and SPEC-012 BR-012-01 both reach for `ReportDataPort.findSnapshotBefore`
 * rather than for the first row in range.
 */
export function resolvePeriod(
  period: Period,
  today: BusinessDate,
  earliest: BusinessDate | null = null,
): Result<DateRange, DomainError<ReportingErrorCode>> {
  const range = boundsFor(period, today, earliest);

  // One validation for all five options, deliberately. A custom range typed
  // backwards is the obvious case, but `all` anchored on a future `earliest`
  // reaches it too — and a position cache holding a future date is a defect
  // worth failing on rather than quietly rendering a one-day report around.
  if (BusinessDate.isAfter(range.from, range.to)) {
    return err(
      domainError(ReportingErrorCode.INVALID_PERIOD_RANGE, {
        kind: period.kind,
        from: range.from,
        to: range.to,
      }),
    );
  }
  return ok(range);
}

function boundsFor(period: Period, today: BusinessDate, earliest: BusinessDate | null): DateRange {
  switch (period.kind) {
    case 'ytd': {
      // 1 January of the year `today` falls in — not "12 months back". On
      // 2026-08-14 that is 2026-01-01, a 226-day period, and on 2026-01-01 it
      // is a single day. Both are correct: YTD is a calendar-anchored window.
      const { year } = parts(today);
      return { from: format({ year, month: 1, day: 1 }), to: today };
    }
    case '12m':
      return { from: monthsBefore(today, 12), to: today };
    case '24m':
      return { from: monthsBefore(today, 24), to: today };
    case 'all':
      return { from: earliest ?? today, to: today };
    case 'custom':
      return { from: period.from, to: period.to };
  }
}

/**
 * The date a report's **holdings** are valued at, as opposed to the range its
 * chart covers.
 *
 * These differ by one case and it matters: a user may legitimately type a
 * custom range ending next month, and the requested range is preserved as
 * typed (silently rewriting what someone asked for is its own kind of lying).
 * But there are no positions in the future, so the holding set is resolved at
 * `min(to, today)` — the last date for which an answer exists. Asking the
 * position cache for a future date would return nothing and render a portfolio
 * worth zero, which is exactly the "misleading zero" BR-011-16 forbids.
 */
export function asOfFor(range: DateRange, today: BusinessDate): BusinessDate {
  return BusinessDate.isAfter(range.to, today) ? today : range.to;
}

const PERIOD_KIND_SET: ReadonlySet<string> = new Set<PeriodKind>([
  'ytd',
  '12m',
  '24m',
  'all',
  'custom',
]);

export function isPeriodKind(value: string): value is PeriodKind {
  return PERIOD_KIND_SET.has(value);
}
