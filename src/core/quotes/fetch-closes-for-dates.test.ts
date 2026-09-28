import { describe, expect, it } from 'vitest';
import { AssetId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import {
  fetchClosesForDates,
  type CloseDateRequest,
  type FetchClosesForDatesPorts,
} from './fetch-closes-for-dates';
import { FakeOfficialCloseSource, FakeQuoteRepository, FakeTradingCalendar } from './test-support';

/**
 * SPEC-005 BR-005-20d / DL-005-22 (#144, review F2), rewritten onto
 * `fetchOfficialCloses` for #171 — the pre-commit close backfill a
 * subscription resolution reads from (`ClosePriceReader.closeOnOrBefore`).
 * Every credit date is its own question: an old close on the same asset must
 * never stand in for a later date's.
 */
const d = (value: string): BusinessDate => BusinessDate.of(value);
const XPML11 = AssetId.generate();
const HSML11 = AssetId.generate();
const OPTIONS = { lookbackDays: 10, annualFileMinDays: 100 };

// Every calendar day in the fixtures is a trading day, so the enumerated
// window is exactly `[upTo - lookbackDays, upTo]` with no day skipped.
function allDaysTradingCalendar(from: string, to: string): FakeTradingCalendar {
  const days: string[] = [];
  for (let cursor = d(from); !BusinessDate.isAfter(cursor, d(to)); ) {
    days.push(cursor);
    const millis = Date.parse(`${cursor}T00:00:00Z`) + 86_400_000;
    cursor = BusinessDate.of(new Date(millis).toISOString().slice(0, 10));
  }
  return new FakeTradingCalendar(days);
}

function ports(overrides: Partial<FetchClosesForDatesPorts> = {}): FetchClosesForDatesPorts & {
  repository: FakeQuoteRepository;
  source: FakeOfficialCloseSource;
} {
  return {
    repository: new FakeQuoteRepository(),
    source: new FakeOfficialCloseSource(),
    calendar: allDaysTradingCalendar('2023-12-01', '2024-04-01'),
    clock: new FakeClock('2024-02-22T15:00:00Z'),
    ...overrides,
  } as never;
}

describe('fetchClosesForDates (SPEC-005 BR-005-20d, #171)', () => {
  it('fetches every trading day in the window ending at the date, and stores every close COTAHIST returns', async () => {
    const p = ports();
    p.source.seedDay(d('2024-02-20'), [
      { ticker: 'XPML11', date: d('2024-02-20'), close: Money.fromString('112.30') },
    ]);
    p.source.seedDay(d('2024-02-22'), [
      { ticker: 'XPML11', date: d('2024-02-22'), close: Money.fromString('114.90') },
    ]);
    const requests: CloseDateRequest[] = [
      { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') },
    ];

    const summary = await fetchClosesForDates(p, requests, OPTIONS);

    expect(p.repository.closeWrites.map((q) => [q.date, q.close.toString(), q.source])).toEqual(
      expect.arrayContaining([
        ['2024-02-20', '112.3', 'b3_cotahist'],
        ['2024-02-22', '114.9', 'b3_cotahist'],
      ]),
    );
    expect(summary.fetched).toHaveLength(2);
  });

  it('AR-19: a date already covered by a COTAHIST close on it, or within the window just before it, requests nothing', async () => {
    const p = ports();
    await p.repository.upsertClosePrice({
      assetId: XPML11,
      date: d('2024-02-16'), // 6 days before — inside the default 10-day window
      close: Money.fromString('110.00'),
      source: 'b3_cotahist',
    });

    const summary = await fetchClosesForDates(
      p,
      [{ assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') }],
      OPTIONS,
    );

    expect(summary.requests).toBe(0);
    expect(summary.fetched).toEqual([]);
    expect(p.source.dayCalls).toEqual([]);
  });

  it('a stored close from a different source (not COTAHIST) never counts as covered', async () => {
    const p = ports();
    await p.repository.upsertClosePrice({
      assetId: XPML11,
      date: d('2024-02-20'),
      close: Money.fromString('999.00'),
      source: 'brapi_free',
    });
    p.source.seedDay(d('2024-02-22'), [
      { ticker: 'XPML11', date: d('2024-02-22'), close: Money.fromString('114.90') },
    ]);

    const summary = await fetchClosesForDates(
      p,
      [{ assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') }],
      OPTIONS,
    );

    expect(summary.requests).toBeGreaterThan(0);
  });

  it('F2 — a stale COTAHIST close OUTSIDE the window never suppresses a fetch for a later date', async () => {
    const p = ports();
    await p.repository.upsertClosePrice({
      assetId: XPML11,
      date: d('2024-01-23'), // 30 days before — past the default 10-day window
      close: Money.fromString('90.00'),
      source: 'b3_cotahist',
    });
    p.source.seedDay(d('2024-02-22'), [
      { ticker: 'XPML11', date: d('2024-02-22'), close: Money.fromString('114.90') },
    ]);

    const summary = await fetchClosesForDates(
      p,
      [{ assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') }],
      OPTIONS,
    );

    expect(summary.fetched.map((q) => q.date)).toContain('2024-02-22');
  });

  it('F2 — two dates on the same asset far enough apart each still get resolved on their own', async () => {
    const p = ports();
    p.source.seedDay(d('2024-01-10'), [
      { ticker: 'XPML11', date: d('2024-01-10'), close: Money.fromString('100.00') },
    ]);
    p.source.seedDay(d('2024-03-01'), [
      { ticker: 'XPML11', date: d('2024-03-01'), close: Money.fromString('120.00') },
    ]);

    const summary = await fetchClosesForDates(
      p,
      [
        { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-01-10') },
        { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-03-01') },
      ],
      OPTIONS,
    );

    expect(summary.fetched.map((q) => q.date).sort()).toEqual(['2024-01-10', '2024-03-01']);
  });

  it('two assets sharing a date are resolved together, deterministically by ticker', async () => {
    const p = ports();
    p.source.seedDay(d('2024-02-22'), [
      { ticker: 'HSML11', date: d('2024-02-22'), close: Money.fromString('90.10') },
      { ticker: 'XPML11', date: d('2024-02-22'), close: Money.fromString('114.90') },
    ]);

    await fetchClosesForDates(
      p,
      [
        { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') },
        { assetId: HSML11, assetCode: 'HSML11', upTo: d('2024-02-22') },
      ],
      OPTIONS,
    );

    expect(p.repository.closeWrites.map((q) => q.assetId)).toEqual([HSML11, XPML11]);
  });

  it('an asset with every date already covered from COTAHIST makes no request at all for it', async () => {
    const p = ports();
    await p.repository.upsertClosePrice({
      assetId: XPML11,
      date: d('2024-02-22'),
      close: Money.fromString('114.90'),
      source: 'b3_cotahist',
    });
    p.source.seedDay(d('2024-02-26'), [
      { ticker: 'HSML11', date: d('2024-02-26'), close: Money.fromString('90.10') },
    ]);

    const summary = await fetchClosesForDates(
      p,
      [
        { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') },
        { assetId: HSML11, assetCode: 'HSML11', upTo: d('2024-02-26') },
      ],
      OPTIONS,
    );

    expect(p.source.dayCalls.every((c) => c.tickers.includes('HSML11'))).toBe(true);
    expect(p.source.dayCalls.some((c) => c.tickers.includes('XPML11'))).toBe(false);
    expect(summary.fetched.map((q) => q.assetId)).toEqual([HSML11]);
  });

  it('a day COTAHIST does not supply is simply not upserted — never fatal', async () => {
    const p = ports();
    p.source.seedDay(d('2024-02-22'), []); // published, no row for XPML11

    const summary = await fetchClosesForDates(
      p,
      [{ assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') }],
      OPTIONS,
    );

    expect(summary.fetched).toEqual([]);
  });

  it('charges no budget and needs no provider — every close is COTAHIST', async () => {
    const p = ports();
    p.source.seedDay(d('2024-02-22'), [
      { ticker: 'XPML11', date: d('2024-02-22'), close: Money.fromString('114.90') },
    ]);

    await fetchClosesForDates(
      p,
      [{ assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') }],
      OPTIONS,
    );

    expect(p.repository.closeWrites.every((q) => q.source === 'b3_cotahist')).toBe(true);
  });

  it('respects a configured lookback window for what counts as already covered', async () => {
    const p = ports();
    await p.repository.upsertClosePrice({
      assetId: XPML11,
      date: d('2024-02-19'), // 3 days before
      close: Money.fromString('112.00'),
      source: 'b3_cotahist',
    });

    const summary = await fetchClosesForDates(
      p,
      [{ assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') }],
      { ...OPTIONS, lookbackDays: 3 },
    );

    expect(summary.requests).toBe(0);
  });

  it('a close exactly at the lookback boundary still counts as covered', async () => {
    const p = ports();
    await p.repository.upsertClosePrice({
      assetId: XPML11,
      date: d('2024-02-12'), // exactly 10 days before 2024-02-22
      close: Money.fromString('108.00'),
      source: 'b3_cotahist',
    });

    const summary = await fetchClosesForDates(
      p,
      [{ assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') }],
      OPTIONS,
    );

    expect(summary.requests).toBe(0);
  });

  it('no requests → no source calls, no writes', async () => {
    const p = ports();
    const summary = await fetchClosesForDates(p, [], OPTIONS);
    expect(summary).toEqual({ fetched: [], requests: 0 });
    expect(p.source.dayCalls).toEqual([]);
  });
});
