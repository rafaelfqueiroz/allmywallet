import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { daysSinceImport, isImportStale } from '@/core/ingestion/staleness';

const today = BusinessDate.of('2026-08-16');

describe('isImportStale — SPEC-005 BR-005-28', () => {
  it('is stale when the user has never imported', () => {
    // The strongest case for the prompt, not the weakest: there is no custody
    // data at all.
    expect(isImportStale({ lastImportAt: null, today, thresholdDays: 30 })).toBe(true);
  });

  it('is not stale on the threshold day itself', () => {
    // 2026-07-17 → 2026-08-16 is exactly 30 days.
    expect(
      isImportStale({ lastImportAt: BusinessDate.of('2026-07-17'), today, thresholdDays: 30 }),
    ).toBe(false);
  });

  it('is stale one day past the threshold', () => {
    expect(
      isImportStale({ lastImportAt: BusinessDate.of('2026-07-16'), today, thresholdDays: 30 }),
    ).toBe(true);
  });

  it('is not stale for an import made today', () => {
    expect(isImportStale({ lastImportAt: today, today, thresholdDays: 30 })).toBe(false);
  });

  it('honours a configured threshold rather than a hardcoded 30', () => {
    const lastImportAt = BusinessDate.of('2026-08-09'); // 7 days ago
    expect(isImportStale({ lastImportAt, today, thresholdDays: 30 })).toBe(false);
    expect(isImportStale({ lastImportAt, today, thresholdDays: 5 })).toBe(true);
  });

  it('counts calendar days across a month boundary', () => {
    expect(daysSinceImport(BusinessDate.of('2026-07-31'), today)).toBe(16);
  });

  it('reports no elapsed days when there is no import to measure from', () => {
    expect(daysSinceImport(null, today)).toBeNull();
  });
});
