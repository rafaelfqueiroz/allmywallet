import { BusinessDate } from '@/core/shared/clock';

/**
 * SPEC-008 BR-008-15 / DL-008-03: a stored quote is re-fetched only when the
 * session is open **and** the entry is older than the cadence interval.
 * Outside the session a stored quote is never stale, however old — a naive
 * TTL would otherwise re-fetch an unchanging Saturday price all weekend.
 */
export function isQuoteStale(
  sessionOpen: boolean,
  cadenceMinutes: number,
  now: Date,
  fetchedAt: Date,
): boolean {
  if (!sessionOpen) return false;
  const ageMinutes = (now.getTime() - fetchedAt.getTime()) / 60_000;
  return ageMinutes > cadenceMinutes;
}

/**
 * The most recent trading day strictly before `today`.
 *
 * SPEC-018 BR-018-16 needs this: a daily-tier price (a published close) has
 * no cadence to be late against, but it can still be genuinely *old* — a
 * `tesouro.sync` that has been dead-lettering for three weeks leaves a close
 * from three weeks ago sitting in `price_quotes`, and a state computed from
 * it would be confident and wrong.
 *
 * "Strictly before" rather than "on or before" because the publisher is a
 * day behind by construction: `tesouro.sync` runs at 18:30 (worker
 * registrations), so during a session the newest close that can exist is the
 * previous trading day's. Asking for today's would mark every Tesouro holding
 * unknown for the whole session, every session.
 *
 * Calendar-derived rather than a configured number of days, which is what
 * makes it correct across weekends and B3 holidays without a tolerance
 * anybody has to tune: the Monday floor is the previous Friday, and a holiday
 * Monday's floor is that Friday too.
 *
 * `isTradingDay` is passed as a function rather than the whole
 * `TradingCalendar` so this stays a pure helper the caller can test with a
 * one-line predicate (TS-02).
 */
export function previousTradingDay(
  isTradingDay: (date: BusinessDate) => boolean,
  today: BusinessDate,
): BusinessDate {
  // Ten days is comfortably past the longest run of consecutive B3 closures
  // (a weekend plus Carnival's Monday and Tuesday is four). Bounded rather
  // than `while (true)` so a calendar that reports *no* trading day — a
  // misconfigured dataset — fails visibly instead of hanging the poll loop.
  let cursor = today;
  for (let back = 0; back < 10; back += 1) {
    cursor = addDays(cursor, -1);
    if (isTradingDay(cursor)) return cursor;
  }
  throw new Error(`previousTradingDay: no trading day in the 10 days before ${today}`);
}

function addDays(date: BusinessDate, days: number): BusinessDate {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days));
  return BusinessDate.of(shifted.toISOString().slice(0, 10));
}
