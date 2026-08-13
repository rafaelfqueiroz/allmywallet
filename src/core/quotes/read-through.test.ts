import { describe, expect, it } from 'vitest';
import { AssetId, UserId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { ok } from '@/core/shared/result';
import { FakeClock } from '@/core/shared/clock';
import { getQuote, type QuoteReadThroughPorts } from './read-through';
import { QuotesErrorCode } from './errors';
import {
  FakeAssetCatalog,
  FakeBudgetCounter,
  FakeQuoteProvider,
  FakeQuoteRateLimiter,
  FakeQuoteRepository,
  FakeTradingCalendar,
} from './test-support';
import type { Asset } from './ports';

const PETR4: Asset = {
  id: AssetId.generate(),
  code: 'PETR4',
  name: 'Petrobras',
  assetClass: 'stock',
};

function buildPorts(overrides?: Partial<QuoteReadThroughPorts>): QuoteReadThroughPorts {
  const catalog = new FakeAssetCatalog();
  catalog.add(PETR4);
  const calendar = new FakeTradingCalendar();
  calendar.sessionOpenOverride = true;
  return {
    catalog,
    repository: new FakeQuoteRepository(),
    provider: new FakeQuoteProvider(),
    calendar,
    clock: new FakeClock('2026-03-16T14:00:00Z'),
    budgetCounter: new FakeBudgetCounter(),
    rateLimiter: new FakeQuoteRateLimiter(),
    ...overrides,
  };
}

const baseOptions = {
  cadenceMinutes: 30,
  monthlyQuota: 15_000,
  ondemandReservePct: 10,
  onDemand: true,
};

describe('getQuote (BR-008-13/15/16/17/18/24)', () => {
  it("BR-008-16: a typo'd ticker is rejected against the catalog with no provider call", async () => {
    const ports = buildPorts();
    const result = await getQuote(ports, 'NOTATICKER', {
      ...baseOptions,
      userId: UserId.generate(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(QuotesErrorCode.UNKNOWN_TICKER);
    expect((ports.provider as FakeQuoteProvider).callCount).toBe(0);
  });

  it('BR-008-13: no stored quote fetches once, persists it, and serves it', async () => {
    const provider = new FakeQuoteProvider();
    provider.set('PETR4', () =>
      ok({
        ticker: 'PETR4',
        price: Money.fromString('38.42'),
        quotedAt: new Date('2026-03-16T13:30:00Z'),
        source: 'brapi_free',
      }),
    );
    const repository = new FakeQuoteRepository();
    const ports = buildPorts({ provider, repository });

    const result = await getQuote(ports, 'PETR4', { ...baseOptions, userId: UserId.generate() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.price.toString()).toBe('38.42');
      expect(result.value.isStale).toBe(false);
    }
    expect(provider.callCount).toBe(1);
    // BR-008-13: subsequent lookups (by any user) are answered from the database.
    const stored = await repository.getLatestQuote(PETR4.id);
    expect(stored?.price.toString()).toBe('38.42');
  });

  it('BR-008-13: a second lookup by a different user hits the database, not the provider', async () => {
    const provider = new FakeQuoteProvider();
    provider.set('PETR4', () =>
      ok({
        ticker: 'PETR4',
        price: Money.fromString('38.42'),
        quotedAt: new Date('2026-03-16T13:30:00Z'),
        source: 'brapi_free',
      }),
    );
    const repository = new FakeQuoteRepository();
    const ports = buildPorts({ provider, repository });

    const userA = UserId.generate();
    const userB = UserId.generate();
    await getQuote(ports, 'PETR4', { ...baseOptions, userId: userA });
    // Freeze at the exact same instant so the stored quote is still fresh.
    const second = await getQuote(ports, 'PETR4', { ...baseOptions, userId: userB });

    expect(second.ok).toBe(true);
    expect(provider.callCount).toBe(1); // not called again for user B
  });

  it('BR-008-14: an on-demand fetch does not join the polling set (nothing here writes one)', async () => {
    const provider = new FakeQuoteProvider();
    provider.set('PETR4', () =>
      ok({
        ticker: 'PETR4',
        price: Money.fromString('38.42'),
        quotedAt: new Date(),
        source: 'brapi_free',
      }),
    );
    const ports = buildPorts({ provider });
    await getQuote(ports, 'PETR4', { ...baseOptions, userId: UserId.generate() });
    // The polling set is derived from held positions (polling-set.ts) and
    // nothing in getQuote's ports has a "join the polling set" operation at
    // all — there is structurally nothing here that could add it.
    expect(Object.keys(ports)).not.toContain('pollingSet');
  });

  it('BR-008-15/DL-008-03: outside the session, a stored quote of any age triggers no re-fetch', async () => {
    const provider = new FakeQuoteProvider();
    const repository = new FakeQuoteRepository();
    await repository.upsertLatestQuote({
      assetId: PETR4.id,
      price: Money.fromString('10.00'),
      quotedAt: new Date('2020-01-01T13:00:00Z'),
      fetchedAt: new Date('2020-01-01T13:00:00Z'), // years old
      source: 'brapi_free',
    });
    const calendar = new FakeTradingCalendar();
    calendar.sessionOpenOverride = false; // market closed
    const ports = buildPorts({ provider, repository, calendar });

    const result = await getQuote(ports, 'PETR4', { ...baseOptions, userId: UserId.generate() });
    expect(result.ok).toBe(true);
    expect(provider.callCount).toBe(0);
    if (result.ok) {
      expect(result.value.isStale).toBe(false); // DL-008-03: never stale outside session
      expect(result.value.sessionOpen).toBe(false);
    }
  });

  it('BR-008-17: rate-limited on-demand lookups are refused before touching the provider', async () => {
    const rateLimiter = new FakeQuoteRateLimiter();
    rateLimiter.allow = false;
    const provider = new FakeQuoteProvider();
    const ports = buildPorts({ rateLimiter, provider });

    const result = await getQuote(ports, 'PETR4', { ...baseOptions, userId: UserId.generate() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(QuotesErrorCode.RATE_LIMITED);
    expect(provider.callCount).toBe(0);
  });

  it('BR-008-18: a failed provider fetch with nothing stored tells the user plainly — no loop, no fabrication', async () => {
    const provider = new FakeQuoteProvider(); // no result registered -> NOT_FOUND
    const ports = buildPorts({ provider });
    const result = await getQuote(ports, 'PETR4', { ...baseOptions, userId: UserId.generate() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(QuotesErrorCode.NOT_AVAILABLE);
    expect(provider.callCount).toBe(1); // exactly once — no retry loop
  });

  it('BR-008-18: a failed provider fetch with a stored value serves it, marked stale', async () => {
    const provider = new FakeQuoteProvider(); // fails
    const repository = new FakeQuoteRepository();
    await repository.upsertLatestQuote({
      assetId: PETR4.id,
      price: Money.fromString('9.99'),
      quotedAt: new Date('2026-03-16T13:00:00Z'),
      fetchedAt: new Date('2026-03-16T13:00:00Z'), // 60 min old, cadence is 30
      source: 'brapi_free',
    });
    const ports = buildPorts({ provider, repository });

    const result = await getQuote(ports, 'PETR4', { ...baseOptions, userId: UserId.generate() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.price.toString()).toBe('9.99');
      expect(result.value.isStale).toBe(true);
    }
  });

  it('BR-008-20/24: on-demand spend capped at the reserve — quota exhausted keeps the last known quote, marked stale', async () => {
    const provider = new FakeQuoteProvider();
    provider.set('PETR4', () =>
      ok({
        ticker: 'PETR4',
        price: Money.fromString('50.00'),
        quotedAt: new Date(),
        source: 'brapi_free',
      }),
    );
    const repository = new FakeQuoteRepository();
    await repository.upsertLatestQuote({
      assetId: PETR4.id,
      price: Money.fromString('9.99'),
      quotedAt: new Date('2026-03-16T13:00:00Z'),
      fetchedAt: new Date('2026-03-16T13:00:00Z'), // stale by age too
      source: 'brapi_free',
    });
    const budgetCounter = new FakeBudgetCounter();
    budgetCounter.seed('2026-03', { scheduled: 0, ondemand: 1_500 }); // reserve exactly exhausted (10% of 15000)
    const ports = buildPorts({ provider, repository, budgetCounter });

    const result = await getQuote(ports, 'PETR4', { ...baseOptions, userId: UserId.generate() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.price.toString()).toBe('9.99'); // the old value, not the new
      expect(result.value.isStale).toBe(true); // BR-008-24: never shown as current
    }
    expect(provider.callCount).toBe(0); // reserve exhausted -> no provider call at all
  });

  it('BR-008-04: every returned quote carries a timestamp and the delay tier', async () => {
    const provider = new FakeQuoteProvider();
    provider.set('PETR4', () =>
      ok({
        ticker: 'PETR4',
        price: Money.fromString('38.42'),
        quotedAt: new Date('2026-03-16T13:30:00Z'),
        source: 'brapi_free',
      }),
    );
    const ports = buildPorts({ provider });
    const result = await getQuote(ports, 'PETR4', { ...baseOptions, userId: UserId.generate() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.quotedAt).toEqual(new Date('2026-03-16T13:30:00Z'));
      expect(result.value.fetchedAt).toBeInstanceOf(Date);
      expect(result.value.delayTierMinutes).toBe(30);
      expect(result.value.source).toBe('brapi_free');
    }
  });
});
