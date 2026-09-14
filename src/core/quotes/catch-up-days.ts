import { BusinessDate } from '@/core/shared/clock';
import type { TradingCalendar } from './ports';

/**
 * SPEC-021 BR-021-28 — which closes a worker that was down has missed.
 *
 * Pure and total: the calendar, the instant and the last recorded capture
 * arrive as arguments, so "three business days down across a weekend and a
 * holiday" is a unit test rather than a wait (TS-02, AR-01).
 *
 * **The window, stated once.** Every B3 trading day `d` with
 *
 *     lastCapturedClose < d <= throughInclusive
 *
 * where `throughInclusive` is today once today's **close-capture time** (17:05
 * in São Paulo, `CLOSE_CAPTURE_LOCAL_TIME`) has passed on a trading day, and
 * yesterday otherwise.
 *
 * Why the capture time and not the session close: between 17:00 and 17:05 the
 * session is closed but `quotes.close-capture` has not fired yet, and it
 * *will* fire. Catch-up taking today in that window would race it — a
 * non-final candle would make the 17:05 capture report `already_captured`, or
 * a `not_supplied` gap would be recorded for a day the capture then fills.
 * Once 17:05 has passed, a worker that was down missed that cron (pg-boss
 * never fires one retroactively), so today is genuinely missed.
 *
 * **The cap keeps the most recent days.** `personal.catchup_max_days` bounds
 * a long absence. Keeping the *oldest* days instead would be self-defeating:
 * the first live close capture after start moves "the last recorded capture"
 * to today, so days dropped from the recent end would never be revisited,
 * while days dropped from the old end are the ones a chart shows least.
 *
 * Worked example (DV-17), against the B3 calendar:
 *
 *   last capture Thu 2026-04-02, now Tue 2026-04-07 11:00 (session open)
 *     Fri 04-03  Sexta-feira Santa — closed
 *     Sat 04-04, Sun 04-05 — weekend
 *     Mon 04-06  trading       → missed
 *     Tue 04-07  session open  → not yet due
 *   days = [2026-04-06]
 */

export interface CatchUpDaysInput {
  readonly calendar: TradingCalendar;
  /** The current instant — decides whether today's close is already due. */
  readonly now: Date;
  /** Today in São Paulo (AR-29), from the same `Clock` as `now`. */
  readonly today: BusinessDate;
  /** `null` when no close was ever captured: there is no absence to measure, so nothing is missed. */
  readonly lastCapturedClose: BusinessDate | null;
  /** `personal.catchup_max_days` — at most this many business days are returned. */
  readonly maxDays: number;
}

export interface CatchUpDays {
  /** Ascending — BR-021-30 recomputes snapshots in this order. */
  readonly days: readonly BusinessDate[];
  /** Missed business days older than the cap, reported so the log can say the window was truncated. */
  readonly beyondCap: number;
}

const MILLISECONDS_PER_DAY = 86_400_000;

function addCalendarDays(date: BusinessDate, days: number): BusinessDate {
  const [year, month, day] = date.split('-').map((part) => Number(part));
  // Date.UTC keeps this independent of the host's timezone (AR-29).
  const millis =
    Date.UTC(Number(year), Number(month) - 1, Number(day)) + days * MILLISECONDS_PER_DAY;
  return BusinessDate.of(new Date(millis).toISOString().slice(0, 10));
}

/**
 * SPEC-008 BR-008-09 — when `quotes.close-capture` runs, in São Paulo local
 * time. The single source for both the worker's cron expression
 * (`CLOSE_CAPTURE_CRON`, used by `src/worker/registrations.ts`) and catch-up's
 * window, so the two cannot drift apart.
 */
export const CLOSE_CAPTURE_LOCAL_TIME = { hour: 17, minute: 5 } as const;

/** Weekdays at `CLOSE_CAPTURE_LOCAL_TIME`; registered with `tz: 'America/Sao_Paulo'` (AR-17). */
export const CLOSE_CAPTURE_CRON = `${CLOSE_CAPTURE_LOCAL_TIME.minute} ${CLOSE_CAPTURE_LOCAL_TIME.hour} * * 1-5`;

/**
 * The instant `quotes.close-capture` fires on `date`. Brazil has observed no
 * daylight-saving time since 2019 (Decree 9,772), so São Paulo is a fixed
 * UTC−3 — the same literal offset `src/adapters/calendar/b3-calendar.ts` uses.
 */
export function closeCaptureInstant(date: BusinessDate): Date {
  const hh = String(CLOSE_CAPTURE_LOCAL_TIME.hour).padStart(2, '0');
  const mm = String(CLOSE_CAPTURE_LOCAL_TIME.minute).padStart(2, '0');
  return new Date(`${date}T${hh}:${mm}:00-03:00`);
}

/**
 * Today when it is a trading day and its close-capture time has passed by
 * `now`; otherwise the day before (trading or not — the caller filters).
 */
export function lastDueCloseDate(
  calendar: TradingCalendar,
  now: Date,
  today: BusinessDate,
): BusinessDate {
  if (calendar.isTradingDay(today) && now.getTime() >= closeCaptureInstant(today).getTime()) {
    return today;
  }
  return addCalendarDays(today, -1);
}

export function enumerateCatchUpDays(input: CatchUpDaysInput): CatchUpDays {
  if (!Number.isInteger(input.maxDays) || input.maxDays < 1) {
    // The registry's schema already refuses this (min 1); reaching here means
    // the value bypassed it, and silently returning nothing would read as
    // "nothing was missed".
    throw new RangeError(`enumerateCatchUpDays: maxDays must be a positive integer`);
  }
  if (input.lastCapturedClose === null) return { days: [], beyondCap: 0 };

  const through = lastDueCloseDate(input.calendar, input.now, input.today);
  const missed: BusinessDate[] = [];
  for (
    let cursor = addCalendarDays(input.lastCapturedClose, 1);
    !BusinessDate.isAfter(cursor, through);
    cursor = addCalendarDays(cursor, 1)
  ) {
    if (input.calendar.isTradingDay(cursor)) missed.push(cursor);
  }

  const kept = missed.slice(Math.max(0, missed.length - input.maxDays));
  return { days: kept, beyondCap: missed.length - kept.length };
}
