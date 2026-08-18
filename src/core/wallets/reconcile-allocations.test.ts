import { describe, expect, it } from 'vitest';
import { AssetId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { allocateToWallet } from '@/core/wallets/allocate';
import { createWallet } from '@/core/wallets/create-wallet';
import { reconcileAllocationsToHoldings } from '@/core/wallets/reconcile-allocations';
import { buildFakeDeps } from '@/core/wallets/test-support/build-deps';

/**
 * SPEC-010 BR-010-05 after a SPEC-006 edit or delete — the position shrinks
 * with no sale row to fold, so nothing else brings the allocations down.
 */

const USER = UserId.generate();
const PETR4 = AssetId.generate();

async function walletFor(deps: ReturnType<typeof buildFakeDeps>, name: string) {
  const result = await createWallet(deps, USER, { name });
  if (!result.ok) throw new Error('setup failed');
  return result.value;
}

describe('reconcileAllocationsToHoldings', () => {
  it('brings allocations down when a deletion shrinks the position below them', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(PETR4, Quantity.fromString('100'), Money.fromString('30'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: PETR4 });

    // The buy of 40 was deleted; `recalculatePositionFrom` has already run.
    deps.positionQuery.set(PETR4, Quantity.fromString('60'), Money.fromString('30'));

    const result = await reconcileAllocationsToHoldings(deps, USER, [PETR4]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([{ assetId: PETR4, excess: '40' }]);
    const allocations = await deps.allocations.listForAsset(PETR4);
    expect(allocations[0]?.quantity.toString()).toBe('60');
  });

  it('splits the reduction proportionally across wallets, as BR-010-17 does', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(PETR4, Quantity.fromString('100'), Money.fromString('30'));
    const retirement = await walletFor(deps, 'Aposentadoria');
    const trading = await walletFor(deps, 'Trading');
    await allocateToWallet(deps, USER, {
      walletId: retirement.id,
      assetId: PETR4,
      quantity: Quantity.fromString('60'),
    });
    await allocateToWallet(deps, USER, {
      walletId: trading.id,
      assetId: PETR4,
      quantity: Quantity.fromString('40'),
    });

    deps.positionQuery.set(PETR4, Quantity.fromString('90'), Money.fromString('30'));

    const result = await reconcileAllocationsToHoldings(deps, USER, [PETR4]);
    expect(result.ok).toBe(true);

    const byWallet = new Map(
      (await deps.allocations.listForAsset(PETR4)).map((a) => [a.walletId, a.quantity.toString()]),
    );
    // 60/40 of a reduction of 10 — `apply-sell.ts`'s own worked example.
    expect(byWallet.get(retirement.id)).toBe('54');
    expect(byWallet.get(trading.id)).toBe('36');
  });

  it('leaves allocations alone when the position still covers them', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(PETR4, Quantity.fromString('100'), Money.fromString('30'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, {
      walletId: wallet.id,
      assetId: PETR4,
      quantity: Quantity.fromString('40'),
    });

    // An edit that *raised* a quantity: the new shares are unallocated, which
    // is BR-010-16's brand-new-holding behaviour, not something to correct.
    deps.positionQuery.set(PETR4, Quantity.fromString('150'), Money.fromString('30'));

    const result = await reconcileAllocationsToHoldings(deps, USER, [PETR4]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
    expect((await deps.allocations.listForAsset(PETR4))[0]?.quantity.toString()).toBe('40');
  });

  it('does nothing for an asset no wallet holds', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(PETR4, Quantity.zero(), Money.zero());

    const result = await reconcileAllocationsToHoldings(deps, USER, [PETR4]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('empties a wallet whose asset is deleted outright', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(PETR4, Quantity.fromString('100'), Money.fromString('30'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: PETR4 });

    deps.positionQuery.set(PETR4, Quantity.zero(), Money.zero());

    const result = await reconcileAllocationsToHoldings(deps, USER, [PETR4]);

    expect(result.ok).toBe(true);
    expect(await deps.allocations.listForAsset(PETR4)).toEqual([]);
  });
});
