import { describe, expect, it } from 'vitest';
import { AssetId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import { domainError } from '@/core/shared/domain-error';
import { err, ok } from '@/core/shared/result';
import {
  fetchClosesForDates,
  type CloseDateRequest,
  type FetchClosesForDatesPorts,
} from './fetch-closes-for-dates';
import { QuoteProviderErrorCode } from './ports';
import { FakeBudgetCounter, FakeQuoteProvider, FakeQuoteRepository } from './test-support';

/**
 * SPEC-005 BR-005-20d / DL-005-22 (#144, review F2) — the pre-commit close
 * backfill a subscription resolution reads from
 * (`ClosePriceReader.closeOnOrBefore`). Every credit date is its own
 * question: an old close on the same asset must never stand in for a later
 * date's, and two dates far enough apart both need their own request.
 */
const d = (value: string): BusinessDate => BusinessDate.of(value);

const XPML11 = AssetId.generate();
const HSML11 = AssetId.generate();
const OPTIONS = { monthlyQuota: 15000, ondemandReservePct: 10 };

function history(ticker: string, closes: Record<string, string>) {
  return () =>
    ok({
      ticker,
      source: 'brapi_free',
      closes: Object.entries(closes).map(([date, close]) => ({
        date: d(date),
        close: Money.fromString(close),
      })),
    });
}

/**
 * A ticker's history keyed by the request's own `to` date — needed whenever a
 * test expects **more than one** `fetchHistoricalCloses` call for the same
 * ticker (`setHistory` holds one factory per ticker, so a second `history(...)`
 * registration for the same ticker would silently replace the first).
 */
function historyByTo(ticker: string, responses: Record<string, Record<string, string>>) {
  return (_from: BusinessDate, to: BusinessDate) => {
    const closes = responses[to];
    if (closes === undefined) {
      return err(domainError(QuoteProviderErrorCode.NOT_FOUND, { ticker }));
    }
    return ok({
      ticker,
      source: 'brapi_free',
      closes: Object.entries(closes).map(([date, close]) => ({
        date: d(date),
        close: Money.fromString(close),
      })),
    });
  };
}

function ports(overrides: Partial<FetchClosesForDatesPorts> = {}): FetchClosesForDatesPorts & {
  repository: FakeQuoteRepository;
  provider: FakeQuoteProvider;
  budgetCounter: FakeBudgetCounter;
} {
  return {
    repository: new FakeQuoteRepository(),
    provider: new FakeQuoteProvider(),
    budgetCounter: new FakeBudgetCounter(),
    clock: new FakeClock('2024-02-22T15:00:00Z'),
    ...overrides,
  } as never;
}

describe('fetchClosesForDates (SPEC-005 BR-005-20d)', () => {
  it('fetches one request for a date, over a window ending at it, and stores every close returned', async () => {
    const p = ports();
    p.provider.setHistory(
      'XPML11',
      history('XPML11', { '2024-02-20': '112.30', '2024-02-22': '114.90' }),
    );
    const requests: CloseDateRequest[] = [
      { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') },
    ];

    const summary = await fetchClosesForDates(p, requests, OPTIONS);

    expect(p.provider.historicalCalls).toEqual([
      { ticker: 'XPML11', from: '2024-02-12', to: '2024-02-22' },
    ]);
    expect(summary.requests).toBe(1);
    expect(p.repository.closeWrites.map((q) => [q.date, q.close.toString(), q.source])).toEqual([
      ['2024-02-20', '112.3', 'brapi_free'],
      ['2024-02-22', '114.9', 'brapi_free'],
    ]);
  });

  it('AR-19: a date already covered by a close on it, or within the window just before it, spends no request', async () => {
    const p = ports();
    // 6 days before the requested date — inside the default 10-day window.
    await p.repository.upsertClosePrice({
      assetId: XPML11,
      date: d('2024-02-16'),
      close: Money.fromString('110.00'),
      source: 'brapi_free',
    });

    const summary = await fetchClosesForDates(
      p,
      [{ assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') }],
      OPTIONS,
    );

    expect(summary.requests).toBe(0);
    expect(p.provider.callCount).toBe(0);
  });

  it('F2 — a stale close OUTSIDE the fetch window never suppresses a fetch for a later date', async () => {
    const p = ports();
    // 30 days before the requested date — well past the default 10-day window.
    await p.repository.upsertClosePrice({
      assetId: XPML11,
      date: d('2024-01-23'),
      close: Money.fromString('90.00'),
      source: 'brapi_free',
    });
    p.provider.setHistory('XPML11', history('XPML11', { '2024-02-22': '114.90' }));

    const summary = await fetchClosesForDates(
      p,
      [{ assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') }],
      OPTIONS,
    );

    expect(summary.requests).toBe(1);
    expect(p.provider.historicalCalls).toEqual([
      { ticker: 'XPML11', from: '2024-02-12', to: '2024-02-22' },
    ]);
  });

  it('F2 — two dates on the same asset far enough apart each get their own request', async () => {
    const p = ports();
    p.provider.setHistory(
      'XPML11',
      historyByTo('XPML11', {
        '2024-01-10': { '2024-01-10': '100.00' },
        '2024-03-01': { '2024-03-01': '120.00' },
      }),
    );

    await fetchClosesForDates(
      p,
      [
        { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-01-10') },
        { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-03-01') },
      ],
      OPTIONS,
    );

    expect(p.provider.historicalCalls).toEqual([
      { ticker: 'XPML11', from: '2024-02-20', to: '2024-03-01' },
      { ticker: 'XPML11', from: '2023-12-31', to: '2024-01-10' },
    ]);
  });

  it('merges two nearby dates on the same asset into one request when its own window already covers both', async () => {
    const p = ports();
    p.provider.setHistory(
      'XPML11',
      history('XPML11', { '2024-02-20': '112.30', '2024-02-22': '114.90' }),
    );

    const summary = await fetchClosesForDates(
      p,
      [
        { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-20') },
        { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') },
      ],
      OPTIONS,
    );

    expect(p.provider.historicalCalls).toEqual([
      { ticker: 'XPML11', from: '2024-02-12', to: '2024-02-22' },
    ]);
    expect(summary.requests).toBe(1);
    expect(p.repository.closeWrites.map((q) => q.date)).toEqual(['2024-02-20', '2024-02-22']);
  });

  it('never merges two dates whose gap exceeds the lookback window', async () => {
    const p = ports();
    p.provider.setHistory(
      'XPML11',
      historyByTo('XPML11', {
        '2024-02-22': { '2024-02-22': '114.90' },
        '2024-02-08': { '2024-02-08': '109.00' },
      }),
    );

    await fetchClosesForDates(
      p,
      [
        // 14 days apart — past the default 10-day lookback.
        { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-08') },
        { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') },
      ],
      OPTIONS,
    );

    expect(p.provider.historicalCalls).toEqual([
      { ticker: 'XPML11', from: '2024-02-12', to: '2024-02-22' },
      { ticker: 'XPML11', from: '2024-01-29', to: '2024-02-08' },
    ]);
  });

  it('requests each distinct asset in code order, deterministically', async () => {
    const p = ports();
    p.provider.setHistory('HSML11', history('HSML11', { '2024-02-26': '90.10' }));
    p.provider.setHistory('XPML11', history('XPML11', { '2024-02-22': '114.90' }));

    await fetchClosesForDates(
      p,
      [
        { assetId: HSML11, assetCode: 'HSML11', upTo: d('2024-02-26') },
        { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') },
      ],
      OPTIONS,
    );

    expect(p.provider.historicalCalls.map((c) => c.ticker)).toEqual(['HSML11', 'XPML11']);
  });

  it('an asset with every date already covered makes no request at all', async () => {
    const p = ports();
    await p.repository.upsertClosePrice({
      assetId: XPML11,
      date: d('2024-02-22'),
      close: Money.fromString('114.90'),
      source: 'brapi_free',
    });
    p.provider.setHistory('HSML11', history('HSML11', { '2024-02-26': '90.10' }));

    const summary = await fetchClosesForDates(
      p,
      [
        { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') },
        { assetId: HSML11, assetCode: 'HSML11', upTo: d('2024-02-26') },
      ],
      OPTIONS,
    );

    expect(p.provider.historicalCalls).toEqual([
      { ticker: 'HSML11', from: '2024-02-16', to: '2024-02-26' },
    ]);
    expect(summary.requests).toBe(1);
  });

  it('a provider failure on one date is never fatal, and a separate date on the same asset still fetches', async () => {
    const p = ports();
    p.provider.setHistory('XPML11', () =>
      err(domainError(QuoteProviderErrorCode.UNAVAILABLE, { ticker: 'XPML11' })),
    );

    const summary = await fetchClosesForDates(
      p,
      [{ assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') }],
      OPTIONS,
    );

    expect(summary.requests).toBe(0);
    expect(summary.fetched).toEqual([]);
    expect(p.budgetCounter.incrementCalls).toEqual([]);
  });

  it('BR-021-32-style budget exhaustion partway through: the first (latest) date succeeds, a second far-apart date on the same asset does not', async () => {
    // quota 10, reserve 10% → scheduled share = floor(10 × 90 / 100) = 9.
    const p = ports();
    p.budgetCounter.seed('2024-02', { scheduled: 8, ondemand: 0 });
    p.provider.setHistory(
      'XPML11',
      historyByTo('XPML11', {
        '2024-02-22': { '2024-02-22': '114.90' },
        '2024-01-01': { '2024-01-01': '80.00' },
      }),
    );

    const summary = await fetchClosesForDates(
      p,
      [
        { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-01-01') },
        { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') },
      ],
      { monthlyQuota: 10, ondemandReservePct: 10 },
    );

    expect(summary.requests).toBe(1);
    expect(p.repository.closeWrites.map((q) => q.date)).toEqual(['2024-02-22']);
  });

  it('an asset the scheduled budget cannot cover at all is skipped entirely', async () => {
    const p = ports();
    p.budgetCounter.seed('2024-02', { scheduled: 9, ondemand: 0 });
    p.provider.setHistory('XPML11', history('XPML11', { '2024-02-22': '114.90' }));

    const summary = await fetchClosesForDates(
      p,
      [{ assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') }],
      { monthlyQuota: 10, ondemandReservePct: 10 },
    );

    expect(summary.requests).toBe(0);
    expect(p.provider.callCount).toBe(0);
  });

  it('charges the scheduled budget for the month of the clock, once per successful request', async () => {
    const p = ports();
    p.provider.setHistory('XPML11', history('XPML11', { '2024-02-22': '114.90' }));

    await fetchClosesForDates(
      p,
      [{ assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') }],
      OPTIONS,
    );

    expect(p.budgetCounter.incrementCalls).toEqual([{ yearMonth: '2024-02', kind: 'scheduled' }]);
  });

  it('respects a configured lookback window, both for the fetch span and for what counts as already covered', async () => {
    const p = ports();
    p.provider.setHistory('XPML11', history('XPML11', { '2024-02-22': '114.90' }));

    await fetchClosesForDates(
      p,
      [{ assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') }],
      { ...OPTIONS, lookbackDays: 3 },
    );

    expect(p.provider.historicalCalls).toEqual([
      { ticker: 'XPML11', from: '2024-02-19', to: '2024-02-22' },
    ]);
  });

  it('a close exactly at the lookback boundary still counts as covered', async () => {
    const p = ports();
    await p.repository.upsertClosePrice({
      assetId: XPML11,
      date: d('2024-02-12'), // exactly 10 days before 2024-02-22
      close: Money.fromString('108.00'),
      source: 'brapi_free',
    });

    const summary = await fetchClosesForDates(
      p,
      [{ assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-22') }],
      OPTIONS,
    );

    expect(summary.requests).toBe(0);
  });

  it('no requests → no provider calls, no writes', async () => {
    const p = ports();
    const summary = await fetchClosesForDates(p, [], OPTIONS);
    expect(summary).toEqual({ fetched: [], requests: 0 });
    expect(p.provider.callCount).toBe(0);
  });
});
