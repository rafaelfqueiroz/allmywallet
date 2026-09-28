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
 * where `throughInclusive` is today once today's **close-capture time**
 * (`quotes.close_capture_time`, São Paulo local, default 22:00) has passed on
 * a trading day, and yesterday otherwise.
 *
 * Why the capture time and not the session close: between the 17:00 session
 * close and the (later, configurable) capture time B3 has not necessarily
 * published the day's COTAHIST file yet — see `quotes.close_capture_time`'s
 * own doc comment in `src/config/registry.ts` for when it typically does.
 * Once the capture time has passed, a worker that was down missed that run
 * (pg-boss never fires one retroactively), so today is genuinely missed.
 *
 * **`lastCapturedClose === null`.** Rather than "nothing is missed", the
 * window is `throughInclusive` alone (when it is a trading day) — SPEC-008
 * BR-008-09 (#171): a newly held asset has never had a close captured, and
 * the daily job must still capture its first one rather than wait for some
 * future "absence" to appear.
 *
 * **The cap keeps the most recent days.** `personal.catchup_max_days` bounds
 * a long absence. Keeping the *oldest* days instead would be self-defeating:
 * the first live close capture after start moves "the last recorded capture"
 * to today, so days dropped from the recent end would never be revisited,
 * while days dropped from the old end are the ones a chart shows least.
 *
 * Worked example (DV-17), against the B3 calendar, `captureTime: '17:05'`:
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
  /** `null` when no close was ever captured — see the class doc above. */
  readonly lastCapturedClose: BusinessDate | null;
  /** `personal.catchup_max_days` — at most this many business days are returned. */
  readonly maxDays: number;
  /** `quotes.close_capture_time` — `'HH:MM'`, São Paulo local (SPEC-002). */
  readonly captureTime: string;
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
 * SPEC-008 BR-008-09, DL-008-14 (#171) — when `quotes.close-capture` runs, in
 * São Paulo local time, as `'HH:MM'`. `quotes.close_capture_time`
 * (`src/config/registry.ts`) is the single source for both the worker's cron
 * expression (`closeCaptureCron`, used by `src/worker/registrations.ts`) and
 * catch-up's window, so the two cannot drift apart.
 *
 * The instant `quotes.close-capture` fires on `date`. Brazil has observed no
 * daylight-saving time since 2019 (Decree 9,772), so São Paulo is a fixed
 * UTC−3 — the same literal offset `src/adapters/calendar/b3-calendar.ts` uses.
 */
export function closeCaptureInstant(date: BusinessDate, captureTime: string): Date {
  const [hh, mm] = captureTime.split(':');
  return new Date(`${date}T${hh}:${mm}:00-03:00`);
}

/**
 * SPEC-008 BR-008-09 (#171) — `MM HH * * *`, every day, not weekdays only: a
 * Friday COTAHIST file B3 publishes only after the run is picked up by
 * Saturday's run instead of waiting until Monday, and a run that finds
 * nothing missing (the common case on a weekend) makes no request.
 */
export function closeCaptureCron(captureTime: string): string {
  const [hh, mm] = captureTime.split(':');
  return `${Number(mm)} ${Number(hh)} * * *`;
}

/**
 * Today when it is a trading day and its close-capture time has passed by
 * `now`; otherwise the day before (trading or not — the caller filters).
 */
export function lastDueCloseDate(
  calendar: TradingCalendar,
  now: Date,
  today: BusinessDate,
  captureTime: string,
): BusinessDate {
  if (
    calendar.isTradingDay(today) &&
    now.getTime() >= closeCaptureInstant(today, captureTime).getTime()
  ) {
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

  const through = lastDueCloseDate(input.calendar, input.now, input.today, input.captureTime);

  if (input.lastCapturedClose === null) {
    // SPEC-008 BR-008-09 (#171): no close ever captured for these assets, so
    // there is no absence to measure — but the daily job must still capture a
    // newly held asset's first close, so the window is the last due day
    // alone rather than empty.
    if (!input.calendar.isTradingDay(through)) return { days: [], beyondCap: 0 };
    return { days: [through], beyondCap: 0 };
  }

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
