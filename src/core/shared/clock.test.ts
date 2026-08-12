import { describe, expect, it } from 'vitest';
import { BusinessDate, FakeClock, businessDateInSaoPaulo } from './clock';

describe('BusinessDate', () => {
  it('accepts an ISO date', () => {
    expect(BusinessDate.of('2026-03-15')).toBe('2026-03-15');
  });

  it('rejects a date that does not exist', () => {
    // `new Date('2026-02-31')` silently normalises to 3 March, which would let
    // an impossible trade date through the B3 parser and shift a transaction
    // across a period boundary (AR-29).
    expect(() => BusinessDate.of('2026-02-31')).toThrow(TypeError);
    expect(() => BusinessDate.of('2026-13-01')).toThrow(TypeError);
  });

  it('rejects anything that is not YYYY-MM-DD', () => {
    expect(() => BusinessDate.of('15/03/2026')).toThrow(TypeError);
    expect(() => BusinessDate.of('2026-3-15')).toThrow(TypeError);
    expect(() => BusinessDate.of('2026-03-15T00:00:00Z')).toThrow(TypeError);
  });

  it('accepts a leap day in a leap year and rejects it otherwise', () => {
    expect(BusinessDate.of('2028-02-29')).toBe('2028-02-29');
    expect(() => BusinessDate.of('2027-02-29')).toThrow(TypeError);
  });

  it('orders lexicographically, which is why the format is fixed', () => {
    const earlier = BusinessDate.of('2026-03-09');
    const later = BusinessDate.of('2026-03-10');
    expect(BusinessDate.compare(earlier, later)).toBe(-1);
    expect(BusinessDate.compare(later, earlier)).toBe(1);
    expect(BusinessDate.compare(earlier, earlier)).toBe(0);
    expect(BusinessDate.isBefore(earlier, later)).toBe(true);
    expect(BusinessDate.isAfter(later, earlier)).toBe(true);
  });
});

describe('businessDateInSaoPaulo', () => {
  it('reads the São Paulo wall-clock date, not UTC', () => {
    // 2026-03-16T02:00Z is still 15 March at 23:00 in São Paulo (UTC-3).
    // Recording this as the 16th would move the trade into the next month for a
    // trade made at the end of March.
    expect(businessDateInSaoPaulo(new Date('2026-03-16T02:00:00Z'))).toBe('2026-03-15');
    expect(businessDateInSaoPaulo(new Date('2026-03-16T03:00:00Z'))).toBe('2026-03-16');
  });
});

describe('FakeClock', () => {
  it('holds time still so time-dependent behaviour is testable (TS-02)', () => {
    const clock = new FakeClock('2026-03-16T13:30:00Z');
    expect(clock.today()).toBe('2026-03-16');
    expect(clock.now().toISOString()).toBe('2026-03-16T13:30:00.000Z');

    // 13:30Z is 10:30 in São Paulo — inside the session. Advancing past the
    // close is how "make no request outside market hours" gets tested.
    clock.advanceMinutes(8 * 60);
    expect(clock.now().toISOString()).toBe('2026-03-16T21:30:00.000Z');
    expect(clock.today()).toBe('2026-03-16');

    clock.set('2026-03-17T00:00:00Z');
    // Midnight UTC is 21:00 the previous day in São Paulo.
    expect(clock.today()).toBe('2026-03-16');
  });

  it('hands out a copy, so a caller cannot mutate the clock', () => {
    const clock = new FakeClock('2026-03-16T13:30:00Z');
    const first = clock.now();
    first.setUTCFullYear(2030);
    expect(clock.now().toISOString()).toBe('2026-03-16T13:30:00.000Z');
  });
});
