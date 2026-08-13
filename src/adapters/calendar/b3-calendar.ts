import { BusinessDate, businessDateInSaoPaulo } from '@/core/shared/clock';
import type { TradingCalendar, TradingSession } from '@/core/quotes/ports';
import {
  B3_HALF_SESSIONS,
  B3_HOLIDAYS,
  HALF_SESSION_CLOSE,
  REGULAR_SESSION,
} from './b3-calendar-data';

/**
 * SPEC-008 BR-008-07 — `market.trading_calendar: 'B3'` selects this adapter.
 * AR-02/AR-03: `TradingCalendar` is a port precisely because "make no
 * request outside the session" is untestable without a controllable
 * implementation — `FakeTradingCalendar` (test-support.ts) is the other side
 * of that seam.
 *
 * Brazil has observed no daylight-saving time since 2019 (Decree 9,772), so
 * `America/Sao_Paulo` is a fixed UTC-3 offset for any date this calendar's
 * data covers — computing session bounds with a literal `-03:00` offset is
 * correct, not a simplification that will silently drift.
 */
const SAO_PAULO_UTC_OFFSET = '-03:00';

function localTimeToUtc(date: string, hour: number, minute: number): Date {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return new Date(`${date}T${hh}:${mm}:00${SAO_PAULO_UTC_OFFSET}`);
}

function isWeekend(date: string): boolean {
  // BusinessDate is YYYY-MM-DD; Date.UTC keeps this independent of the host's
  // own timezone, which .getDay() on a bare `new Date(date)` would not be.
  const parts = date.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

export class B3TradingCalendar implements TradingCalendar {
  isTradingDay(date: BusinessDate): boolean {
    return !isWeekend(date) && !B3_HOLIDAYS.includes(date);
  }

  sessionFor(date: BusinessDate): TradingSession | undefined {
    if (!this.isTradingDay(date)) return undefined;
    const isHalfSession = B3_HALF_SESSIONS.includes(date);
    const openUtc = localTimeToUtc(date, REGULAR_SESSION.openHour, REGULAR_SESSION.openMinute);
    const closeUtc = isHalfSession
      ? localTimeToUtc(date, HALF_SESSION_CLOSE.closeHour, HALF_SESSION_CLOSE.closeMinute)
      : localTimeToUtc(date, REGULAR_SESSION.closeHour, REGULAR_SESSION.closeMinute);
    return { date, openUtc, closeUtc, isHalfSession };
  }

  isSessionOpen(instant: Date): boolean {
    const date = businessDateInSaoPaulo(instant);
    const session = this.sessionFor(date);
    if (!session) return false;
    return instant >= session.openUtc && instant < session.closeUtc;
  }

  regularSessionMinutes(): number {
    const openMinutes = REGULAR_SESSION.openHour * 60 + REGULAR_SESSION.openMinute;
    const closeMinutes = REGULAR_SESSION.closeHour * 60 + REGULAR_SESSION.closeMinute;
    return closeMinutes - openMinutes;
  }

  tradingDaysInMonth(yearMonth: string): number {
    const [yearStr, monthStr] = yearMonth.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    let count = 0;
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = BusinessDate.of(`${yearMonth}-${String(day).padStart(2, '0')}`);
      if (this.isTradingDay(date)) count += 1;
    }
    return count;
  }
}
