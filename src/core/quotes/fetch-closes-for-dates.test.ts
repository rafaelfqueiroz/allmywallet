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
 * SPEC-005 BR-005-20d / DL-005-22 (#144) — the pre-commit close backfill a
 * subscription resolution reads from (`ClosePriceReader.closeOnOrBefore`).
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
  it('fetches one request per asset, over a window ending at the requested date, and stores every close returned', async () => {
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

  it('AR-19: an asset already holding a close on or before the requested date spends no request', async () => {
    const p = ports();
    await p.repository.upsertClosePrice({
      assetId: XPML11,
      date: d('2024-02-01'),
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

  it('collapses several requests for the same asset into one, at the latest upTo needed', async () => {
    const p = ports();
    p.provider.setHistory('XPML11', history('XPML11', { '2024-03-01': '120.00' }));

    await fetchClosesForDates(
      p,
      [
        { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-01-10') },
        { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-03-01') },
        { assetId: XPML11, assetCode: 'XPML11', upTo: d('2024-02-15') },
      ],
      OPTIONS,
    );

    expect(p.provider.historicalCalls).toEqual([
      { ticker: 'XPML11', from: '2024-02-20', to: '2024-03-01' },
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

  it('a provider failure fetches nothing for that asset and spends no budget — never fatal to the caller', async () => {
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

  it('BR-021-32-style budget exhaustion: an asset the scheduled budget cannot cover is skipped', async () => {
    // quota 10, reserve 10% → scheduled share = floor(10 × 90 / 100) = 9.
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

  it('respects a configured lookback window', async () => {
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

  it('no requests → no provider calls, no writes', async () => {
    const p = ports();
    const summary = await fetchClosesForDates(p, [], OPTIONS);
    expect(summary).toEqual({ fetched: [], requests: 0 });
    expect(p.provider.callCount).toBe(0);
  });
});
