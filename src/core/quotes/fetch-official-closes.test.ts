import { describe, expect, it } from 'vitest';
import { AssetId } from '@/core/shared/ids';
import { BusinessDate } from '@/core/shared/clock';
import { Money } from '@/core/shared/money';
import { fetchOfficialCloses, type WantedClose } from './fetch-official-closes';
import { OfficialCloseSourceErrorCode } from './ports';
import { FakeOfficialCloseSource } from './test-support';

/**
 * SPEC-008 BR-008-09/BR-008-30 (#171) — pure orchestration over
 * `OfficialCloseSource`. `sync-official-closes.test.ts` covers the writing
 * rules; this covers only the day-vs-annual choice, the NOT_PUBLISHED →
 * annual fallback, and the four-way classification.
 */
const d = (value: string): BusinessDate => BusinessDate.of(value);
const PETR4 = AssetId.generate();
const VALE3 = AssetId.generate();

function wanted(assetId: AssetId, ticker: string, dates: readonly string[]): WantedClose[] {
  return dates.map((date) => ({ assetId, ticker, date: d(date) }));
}

describe('fetchOfficialCloses (SPEC-008 BR-008-09/BR-008-30)', () => {
  it('below the annual threshold, reads one daily file per distinct day, ascending', async () => {
    const source = new FakeOfficialCloseSource();
    source.seedDay(d('2026-03-12'), [{ ticker: 'PETR4', date: d('2026-03-12'), close: Money.fromString('31.10') }]);
    source.seedDay(d('2026-03-13'), [{ ticker: 'PETR4', date: d('2026-03-13'), close: Money.fromString('29.00') }]);

    const result = await fetchOfficialCloses(
      { source },
      wanted(PETR4, 'PETR4', ['2026-03-13', '2026-03-12']),
      { annualFileMinDays: 100, currentYear: 2026 },
    );

    expect(source.dayCalls.map((c) => c.date)).toEqual(['2026-03-12', '2026-03-13']);
    expect(source.yearCalls).toEqual([]);
    expect(result.requests).toBe(2);
    expect(result.found.map((f) => [f.date, f.close.toString()])).toEqual([
      ['2026-03-12', '31.1'],
      ['2026-03-13', '29'],
    ]);
  });

  it('at or above the annual threshold, reads one annual file covering the whole year', async () => {
    const source = new FakeOfficialCloseSource();
    const closes = Array.from({ length: 5 }, (_, i) => ({
      ticker: 'PETR4',
      date: d(`2026-01-0${i + 1}`),
      close: Money.fromString(`10.${i}0`),
    }));
    source.seedYear(2026, closes, d('2026-01-05'));

    const dates = closes.map((c) => c.date);
    const result = await fetchOfficialCloses({ source }, wanted(PETR4, 'PETR4', dates), {
      annualFileMinDays: 5,
      currentYear: 2026,
    });

    expect(source.yearCalls).toEqual([{ year: 2026, tickers: ['PETR4'] }]);
    expect(source.dayCalls).toEqual([]);
    expect(result.requests).toBe(1);
    expect(result.found).toHaveLength(5);
  });

  it('a day published with no row for the ticker is not_supplied', async () => {
    const source = new FakeOfficialCloseSource();
    source.seedDay(d('2026-03-13'), []); // published, empty for this ticker
    const result = await fetchOfficialCloses({ source }, wanted(PETR4, 'PETR4', ['2026-03-13']), {
      annualFileMinDays: 100,
      currentYear: 2026,
    });
    expect(result.notSupplied).toEqual([{ assetId: PETR4, ticker: 'PETR4', date: '2026-03-13' }]);
    expect(result.found).toEqual([]);
  });

  it('a date after the file’s lastDate is unpublished, even though the request succeeded', async () => {
    const source = new FakeOfficialCloseSource();
    source.seedDay(d('2026-03-13'), [], d('2026-03-12')); // stale file, e.g. weekend request served yesterday's
    const result = await fetchOfficialCloses({ source }, wanted(PETR4, 'PETR4', ['2026-03-13']), {
      annualFileMinDays: 100,
      currentYear: 2026,
    });
    expect(result.unpublished).toEqual([{ assetId: PETR4, ticker: 'PETR4', date: '2026-03-13' }]);
  });

  it('a file with no quote rows at all (lastDate null) leaves every requested date unpublished', async () => {
    const source = new FakeOfficialCloseSource();
    source.seedDay(d('2026-03-13'), [], null);
    const result = await fetchOfficialCloses({ source }, wanted(PETR4, 'PETR4', ['2026-03-13']), {
      annualFileMinDays: 100,
      currentYear: 2026,
    });
    expect(result.unpublished).toEqual([{ assetId: PETR4, ticker: 'PETR4', date: '2026-03-13' }]);
  });

  it('NOT_PUBLISHED with nothing seeded is unpublished for the current year — no annual fallback', async () => {
    const source = new FakeOfficialCloseSource();
    const result = await fetchOfficialCloses({ source }, wanted(PETR4, 'PETR4', ['2026-03-13']), {
      annualFileMinDays: 100,
      currentYear: 2026,
    });
    expect(result.unpublished).toEqual([{ assetId: PETR4, ticker: 'PETR4', date: '2026-03-13' }]);
    expect(source.yearCalls).toEqual([]);
    expect(result.requests).toBe(1);
  });

  it('NOT_PUBLISHED for a day in a past year falls back to that year’s annual file once, covering every remaining day', async () => {
    const source = new FakeOfficialCloseSource();
    // No daily file for 2024-01-10 or 2024-06-20 — B3 no longer retains them.
    source.seedYear(
      2024,
      [
        { ticker: 'PETR4', date: d('2024-01-10'), close: Money.fromString('20.00') },
        { ticker: 'PETR4', date: d('2024-06-20'), close: Money.fromString('22.50') },
      ],
      d('2024-12-30'),
    );

    const result = await fetchOfficialCloses(
      { source },
      wanted(PETR4, 'PETR4', ['2024-01-10', '2024-06-20']),
      { annualFileMinDays: 100, currentYear: 2026 },
    );

    // One fetchDay (the first day, which triggers the fallback) + one fetchYear.
    expect(source.dayCalls.map((c) => c.date)).toEqual(['2024-01-10']);
    expect(source.yearCalls).toEqual([{ year: 2024, tickers: ['PETR4'] }]);
    expect(result.requests).toBe(2);
    expect(result.found.map((f) => f.date)).toEqual(['2024-01-10', '2024-06-20']);
  });

  it('the annual fallback’s own failure is unavailable for every remaining day of that year', async () => {
    const source = new FakeOfficialCloseSource();
    source.seedYearError(2024, OfficialCloseSourceErrorCode.UNAVAILABLE);

    const result = await fetchOfficialCloses(
      { source },
      wanted(PETR4, 'PETR4', ['2024-01-10', '2024-06-20']),
      { annualFileMinDays: 100, currentYear: 2026 },
    );

    expect(result.unavailable.map((p) => p.date)).toEqual(['2024-01-10', '2024-06-20']);
  });

  it('UNAVAILABLE on a daily request is unavailable, never a silent unpublished', async () => {
    const source = new FakeOfficialCloseSource();
    source.seedDayError(d('2026-03-13'), OfficialCloseSourceErrorCode.UNAVAILABLE);
    const result = await fetchOfficialCloses({ source }, wanted(PETR4, 'PETR4', ['2026-03-13']), {
      annualFileMinDays: 100,
      currentYear: 2026,
    });
    expect(result.unavailable).toEqual([{ assetId: PETR4, ticker: 'PETR4', date: '2026-03-13' }]);
  });

  it('NOT_PUBLISHED on a direct (non-fallback) annual request is unpublished for every wanted pair of that year', async () => {
    const source = new FakeOfficialCloseSource();
    // Nothing seeded → NOT_PUBLISHED is the fake's default.
    const result = await fetchOfficialCloses({ source }, wanted(PETR4, 'PETR4', ['2026-03-13']), {
      annualFileMinDays: 1,
      currentYear: 2026,
    });
    expect(result.unpublished).toEqual([{ assetId: PETR4, ticker: 'PETR4', date: '2026-03-13' }]);
    expect(result.unavailable).toEqual([]);
  });

  it('UNAVAILABLE on the annual request is unavailable for every wanted pair of that year', async () => {
    const source = new FakeOfficialCloseSource();
    source.seedYearError(2026, OfficialCloseSourceErrorCode.UNAVAILABLE);
    const result = await fetchOfficialCloses({ source }, wanted(PETR4, 'PETR4', ['2026-03-13']), {
      annualFileMinDays: 1,
      currentYear: 2026,
    });
    expect(result.unavailable).toEqual([{ assetId: PETR4, ticker: 'PETR4', date: '2026-03-13' }]);
  });

  it('a second run of the same wanted set makes the same number of requests (AR-19: no state hidden here)', async () => {
    const source = new FakeOfficialCloseSource();
    source.seedDay(d('2026-03-13'), [{ ticker: 'PETR4', date: d('2026-03-13'), close: Money.fromString('29.00') }]);
    const input = wanted(PETR4, 'PETR4', ['2026-03-13']);

    const first = await fetchOfficialCloses({ source }, input, { annualFileMinDays: 100, currentYear: 2026 });
    const second = await fetchOfficialCloses({ source }, input, { annualFileMinDays: 100, currentYear: 2026 });

    expect(first.requests).toBe(1);
    expect(second.requests).toBe(1);
    expect(second.found).toEqual(first.found);
  });

  it('is deterministic regardless of input order: grouped by year, then ticker, then date', async () => {
    const source = new FakeOfficialCloseSource();
    source.seedDay(d('2026-03-12'), [
      { ticker: 'PETR4', date: d('2026-03-12'), close: Money.fromString('31.10') },
      { ticker: 'VALE3', date: d('2026-03-12'), close: Money.fromString('61.00') },
    ]);

    const shuffled: WantedClose[] = [
      { assetId: VALE3, ticker: 'VALE3', date: d('2026-03-12') },
      { assetId: PETR4, ticker: 'PETR4', date: d('2026-03-12') },
    ];
    const result = await fetchOfficialCloses({ source }, shuffled, {
      annualFileMinDays: 100,
      currentYear: 2026,
    });

    expect(result.found.map((f) => f.ticker)).toEqual(['PETR4', 'VALE3']);
  });

  it('the annual fallback itself coming back NOT_PUBLISHED leaves every remaining day of that year unpublished', async () => {
    const source = new FakeOfficialCloseSource();
    // No daily files seeded and no annual file seeded → both come back
    // NOT_PUBLISHED (the fake's default when nothing was seeded).
    const result = await fetchOfficialCloses(
      { source },
      wanted(PETR4, 'PETR4', ['2024-01-10', '2024-06-20']),
      { annualFileMinDays: 100, currentYear: 2026 },
    );

    expect(source.dayCalls.map((c) => c.date)).toEqual(['2024-01-10']);
    expect(source.yearCalls).toEqual([{ year: 2024, tickers: ['PETR4'] }]);
    expect(result.unpublished.map((p) => p.date)).toEqual(['2024-01-10', '2024-06-20']);
    expect(result.found).toEqual([]);
  });

  it('an empty wanted list makes no request', async () => {
    const source = new FakeOfficialCloseSource();
    const result = await fetchOfficialCloses({ source }, [], { annualFileMinDays: 100, currentYear: 2026 });
    expect(result).toEqual({ found: [], notSupplied: [], unavailable: [], unpublished: [], requests: 0 });
    expect(source.dayCalls).toEqual([]);
  });

  it('two different years are each resolved on their own (one below, one at the annual threshold)', async () => {
    const source = new FakeOfficialCloseSource();
    source.seedDay(d('2026-03-13'), [{ ticker: 'PETR4', date: d('2026-03-13'), close: Money.fromString('29.00') }]);
    const closes2024 = Array.from({ length: 3 }, (_, i) => ({
      ticker: 'PETR4',
      date: d(`2024-01-0${i + 1}`),
      close: Money.fromString(`10.${i}0`),
    }));
    source.seedYear(2024, closes2024, d('2024-12-30'));

    const result = await fetchOfficialCloses(
      { source },
      [...wanted(PETR4, 'PETR4', ['2026-03-13']), ...wanted(PETR4, 'PETR4', closes2024.map((c) => c.date))],
      { annualFileMinDays: 3, currentYear: 2026 },
    );

    expect(source.yearCalls).toEqual([{ year: 2024, tickers: ['PETR4'] }]);
    expect(source.dayCalls).toEqual([{ date: '2026-03-13', tickers: ['PETR4'] }]);
    expect(result.found).toHaveLength(4);
  });
});
