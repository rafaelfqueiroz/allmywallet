import { describe, expect, it } from 'vitest';
import { AssetId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { FakeClock } from '@/core/shared/clock';
import { ok } from '@/core/shared/result';
import { pollHeldAsset, type PollAssetPorts } from './poll-held-asset';
import { FakeBudgetCounter, FakeQuoteProvider, FakeQuoteRepository } from './test-support';
import type { Asset } from './ports';

const PETR4: Asset = {
  id: AssetId.generate(),
  code: 'PETR4',
  name: 'Petrobras',
  assetClass: 'stock',
};

function buildPorts(overrides?: Partial<PollAssetPorts>): PollAssetPorts {
  return {
    repository: new FakeQuoteRepository(),
    provider: new FakeQuoteProvider(),
    budgetCounter: new FakeBudgetCounter(),
    clock: new FakeClock('2026-03-16T14:00:00Z'),
    ...overrides,
  };
}

const options = { cadenceMinutes: 30, monthlyQuota: 15_000, ondemandReservePct: 10 };

describe('pollHeldAsset (BR-008-05 scheduled polling; AR-19 idempotency)', () => {
  it('polls, persists, and spends exactly one scheduled budget unit', async () => {
    const provider = new FakeQuoteProvider();
    provider.set('PETR4', () =>
      ok({
        ticker: 'PETR4',
        price: Money.fromString('38.42'),
        quotedAt: new Date(),
        source: 'brapi_free',
      }),
    );
    const budgetCounter = new FakeBudgetCounter();
    const ports = buildPorts({ provider, budgetCounter });

    const result = await pollHeldAsset(ports, PETR4, options);
    expect(result.outcome).toBe('polled');
    expect(provider.callCount).toBe(1);
    expect(budgetCounter.incrementCalls).toEqual([{ yearMonth: '2026-03', kind: 'scheduled' }]);
  });

  it('AR-19: a retried poll for the same asset within the cadence window makes no second call', async () => {
    const provider = new FakeQuoteProvider();
    provider.set('PETR4', () =>
      ok({
        ticker: 'PETR4',
        price: Money.fromString('38.42'),
        quotedAt: new Date(),
        source: 'brapi_free',
      }),
    );
    const budgetCounter = new FakeBudgetCounter();
    const ports = buildPorts({ provider, budgetCounter });

    const first = await pollHeldAsset(ports, PETR4, options);
    const retried = await pollHeldAsset(ports, PETR4, options); // pg-boss retry, same instant
    expect(first.outcome).toBe('polled');
    expect(retried.outcome).toBe('already_fresh');
    expect(provider.callCount).toBe(1); // not called twice
    expect(budgetCounter.incrementCalls).toHaveLength(1); // budget not double-spent
  });

  it('BR-008-22/24: skips the call when the scheduled budget is exhausted, leaving the stored value in place', async () => {
    const provider = new FakeQuoteProvider();
    provider.set('PETR4', () =>
      ok({
        ticker: 'PETR4',
        price: Money.fromString('99.00'),
        quotedAt: new Date(),
        source: 'brapi_free',
      }),
    );
    const budgetCounter = new FakeBudgetCounter();
    budgetCounter.seed('2026-03', { scheduled: 13_500, ondemand: 0 }); // scheduled ceiling exactly reached
    const ports = buildPorts({ provider, budgetCounter });

    const result = await pollHeldAsset(ports, PETR4, options);
    expect(result.outcome).toBe('skipped_budget');
    expect(provider.callCount).toBe(0);
  });

  it('BR-008-27: a provider failure is reported, not retried in a loop here', async () => {
    const provider = new FakeQuoteProvider(); // no result registered -> fails
    const ports = buildPorts({ provider });
    const result = await pollHeldAsset(ports, PETR4, options);
    expect(result.outcome).toBe('failed');
    expect(provider.callCount).toBe(1);
  });
});
