import { describe, expect, it } from 'vitest';
import { AssetId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import { ok } from '@/core/shared/result';
import { captureClosePrice, type CaptureClosePorts } from './capture-close-price';
import { FakeBudgetCounter, FakeQuoteProvider, FakeQuoteRepository } from './test-support';
import type { Asset } from './ports';

const PETR4: Asset = {
  id: AssetId.generate(),
  code: 'PETR4',
  name: 'Petrobras',
  assetClass: 'stock',
};

function buildPorts(overrides?: Partial<CaptureClosePorts>): CaptureClosePorts {
  return {
    repository: new FakeQuoteRepository(),
    provider: new FakeQuoteProvider(),
    budgetCounter: new FakeBudgetCounter(),
    clock: new FakeClock('2026-03-16T20:05:00Z'), // just after the session closes
    ...overrides,
  };
}

describe('captureClosePrice (BR-008-09/10; AR-19 idempotency)', () => {
  it('captures the official close into price_quotes history', async () => {
    const provider = new FakeQuoteProvider();
    provider.set('PETR4', () =>
      ok({
        ticker: 'PETR4',
        price: Money.fromString('38.90'),
        quotedAt: new Date(),
        source: 'brapi_free',
      }),
    );
    const repository = new FakeQuoteRepository();
    const ports = buildPorts({ provider, repository });

    const result = await captureClosePrice(ports, PETR4);
    expect(result.outcome).toBe('captured');
    const stored = await repository.getClosePrice(PETR4.id, BusinessDate.of('2026-03-16'));
    expect(stored?.close.toString()).toBe('38.9');
  });

  it('BR-008-09: the close supersedes the last intraday quote — a subsequent intraday poll never rewrites it', async () => {
    const provider = new FakeQuoteProvider();
    provider.set('PETR4', () =>
      ok({
        ticker: 'PETR4',
        price: Money.fromString('38.90'),
        quotedAt: new Date(),
        source: 'brapi_free',
      }),
    );
    const repository = new FakeQuoteRepository();
    const ports = buildPorts({ provider, repository });
    await captureClosePrice(ports, PETR4);

    // BR-008-10: latest_quotes is a wholly separate table — nothing in this
    // use case ever writes to it, so an intraday refresh cannot touch history.
    const latest = await repository.getLatestQuote(PETR4.id);
    expect(latest).toBeNull();
  });

  it('AR-19: a retried capture for a date already captured makes no second provider call', async () => {
    const provider = new FakeQuoteProvider();
    provider.set('PETR4', () =>
      ok({
        ticker: 'PETR4',
        price: Money.fromString('38.90'),
        quotedAt: new Date(),
        source: 'brapi_free',
      }),
    );
    const budgetCounter = new FakeBudgetCounter();
    const ports = buildPorts({ provider, budgetCounter });

    const first = await captureClosePrice(ports, PETR4);
    const retried = await captureClosePrice(ports, PETR4);
    expect(first.outcome).toBe('captured');
    expect(retried.outcome).toBe('already_captured');
    expect(provider.callCount).toBe(1);
    expect(budgetCounter.incrementCalls).toHaveLength(1);
  });

  it('a provider failure is reported without writing a partial row', async () => {
    const provider = new FakeQuoteProvider();
    const repository = new FakeQuoteRepository();
    const ports = buildPorts({ provider, repository });
    const result = await captureClosePrice(ports, PETR4);
    expect(result.outcome).toBe('failed');
    expect(await repository.getClosePrice(PETR4.id, BusinessDate.of('2026-03-16'))).toBeNull();
  });
});
