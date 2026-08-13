import { describe, expect, it } from 'vitest';
import { AssetId, UserId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { FakeClock } from '@/core/shared/clock';
import { ok } from '@/core/shared/result';
import { refreshPortfolioQuotes } from './refresh-portfolio-quotes';
import { QuotesErrorCode } from './errors';
import type { QuoteReadThroughPorts } from './read-through';
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
const VALE3: Asset = { id: AssetId.generate(), code: 'VALE3', name: 'Vale', assetClass: 'stock' };

function buildPorts(overrides?: Partial<QuoteReadThroughPorts>): QuoteReadThroughPorts {
  const catalog = new FakeAssetCatalog();
  catalog.add(PETR4);
  catalog.add(VALE3);
  const calendar = new FakeTradingCalendar();
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

const options = { cadenceMinutes: 30, monthlyQuota: 15_000, ondemandReservePct: 10 };

describe('refreshPortfolioQuotes (BR-008-28)', () => {
  it('outside session hours, makes no provider call and explains why', async () => {
    const calendar = new FakeTradingCalendar();
    calendar.sessionOpenOverride = false;
    const provider = new FakeQuoteProvider();
    const ports = buildPorts({ calendar, provider });

    const result = await refreshPortfolioQuotes(ports, [PETR4, VALE3], UserId.generate(), options);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.refreshed).toBe(false);
      expect(result.value.reason).toBe('MARKET_CLOSED');
    }
    expect(provider.callCount).toBe(0);
  });

  it('during an open session, fetches fresh quotes for every held asset', async () => {
    const calendar = new FakeTradingCalendar();
    calendar.sessionOpenOverride = true;
    const provider = new FakeQuoteProvider();
    provider.set('PETR4', () =>
      ok({
        ticker: 'PETR4',
        price: Money.fromString('38.42'),
        quotedAt: new Date(),
        source: 'brapi_free',
      }),
    );
    provider.set('VALE3', () =>
      ok({
        ticker: 'VALE3',
        price: Money.fromString('61.10'),
        quotedAt: new Date(),
        source: 'brapi_free',
      }),
    );
    const ports = buildPorts({ calendar, provider });

    const result = await refreshPortfolioQuotes(ports, [PETR4, VALE3], UserId.generate(), options);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.refreshed).toBe(true);
      expect(result.value.quotes).toHaveLength(2);
    }
    expect(provider.callCount).toBe(2);
  });

  it('is rate-limited per user — the limiter is checked once for the whole batch, not per asset', async () => {
    const rateLimiter = new FakeQuoteRateLimiter();
    rateLimiter.allow = false;
    const provider = new FakeQuoteProvider();
    const ports = buildPorts({ rateLimiter, provider });

    const result = await refreshPortfolioQuotes(ports, [PETR4, VALE3], UserId.generate(), options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(QuotesErrorCode.RATE_LIMITED);
    expect(rateLimiter.consumedFor).toHaveLength(1);
    expect(provider.callCount).toBe(0);
  });
});
