import { describe, expect, it } from 'vitest';
import { isQuoteStale } from './staleness';

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
