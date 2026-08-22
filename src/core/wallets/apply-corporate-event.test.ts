import { describe, expect, it } from 'vitest';
import { AssetId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { allocateToWallet } from '@/core/wallets/allocate';
import { applyCorporateEventToAllocations } from '@/core/wallets/apply-corporate-event';
import { createWallet } from '@/core/wallets/create-wallet';
import { buildFakeDeps } from '@/core/wallets/test-support/build-deps';
import { BusinessDate } from '@/core/shared/clock';

/** SPEC-014 BR-014-12: the scaling is dated by the event, not by the clock. */
const EVENT_DATE = BusinessDate.of('2026-03-10');

const USER = UserId.generate();
const ITSA4 = AssetId.generate();

async function walletFor(deps: ReturnType<typeof buildFakeDeps>, name: string) {
  const result = await createWallet(deps, USER, { name });
  if (!result.ok) throw new Error('setup failed');
  return result.value;
}

describe('SPEC-010 BR-010-18/DL-010-08 — applyCorporateEventToAllocations', () => {
  it('AC — a 1:2 split doubles allocated quantities in every wallet and preserves each share', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const retirement = await walletFor(deps, 'Aposentadoria');
    const trading = await walletFor(deps, 'Trading');
    await allocateToWallet(deps, USER, {
      walletId: retirement.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('60'),
    });
    await allocateToWallet(deps, USER, {
      walletId: trading.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('40'),
    });

    const result = await applyCorporateEventToAllocations(
      deps,
      USER,
      ITSA4,
      Quantity.fromString('2'),
      EVENT_DATE,
    );

    expect(result.ok).toBe(true);
    const retirementAlloc = (await deps.allocations.listForWallet(retirement.id))[0];
    const tradingAlloc = (await deps.allocations.listForWallet(trading.id))[0];
    expect(retirementAlloc?.quantity.toString()).toBe('120');
    expect(tradingAlloc?.quantity.toString()).toBe('80');
    // Proportional share preserved: 120:80 is still 60:40 = 3:2.
    expect(
      retirementAlloc?.quantity
        .dividedBy(tradingAlloc?.quantity ?? Quantity.fromString('1'))
        .toString(),
    ).toBe('1.5');
    // BR-010-18/BR-007-04 analogy: cost basis is unchanged by a split.
    expect(retirementAlloc?.costBasisAtAllocation?.toString()).toBe('600');
  });

  it('a grupamento 10:1 (ratio 0.1) reduces quantities by the same factor', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('1000'), Money.fromString('1'));
    const wallet = await walletFor(deps, 'Trading');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });

    const result = await applyCorporateEventToAllocations(
      deps,
      USER,
      ITSA4,
      Quantity.fromString('0.1'),
      EVENT_DATE,
    );
    expect(result.ok).toBe(true);
    const alloc = (await deps.allocations.listForWallet(wallet.id))[0];
    expect(alloc?.quantity.toString()).toBe('100');
  });

  it('refuses a zero or negative ratio', async () => {
    const deps = buildFakeDeps();
    const result = await applyCorporateEventToAllocations(
      deps,
      USER,
      ITSA4,
      Quantity.zero(),
      EVENT_DATE,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_RATIO');
  });

  it('is a no-op when nobody has allocated the asset', async () => {
    const deps = buildFakeDeps();
    const result = await applyCorporateEventToAllocations(
      deps,
      USER,
      ITSA4,
      Quantity.fromString('2'),
      EVENT_DATE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});
