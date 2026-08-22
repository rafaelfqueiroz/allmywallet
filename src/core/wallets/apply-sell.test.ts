import { describe, expect, it } from 'vitest';
import { AssetId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { allocateToWallet } from '@/core/wallets/allocate';
import { applySell } from '@/core/wallets/apply-sell';
import { createWallet } from '@/core/wallets/create-wallet';
import { buildFakeDeps } from '@/core/wallets/test-support/build-deps';
import { BusinessDate } from '@/core/shared/clock';

/** SPEC-014 BR-014-12: every allocation write is dated; these cases do not vary it. */
const TRADE_DATE = BusinessDate.of('2026-03-10');

const USER = UserId.generate();
const ITSA4 = AssetId.generate();

async function walletFor(deps: ReturnType<typeof buildFakeDeps>, name: string) {
  const result = await createWallet(deps, USER, { name });
  if (!result.ok) throw new Error('setup failed');
  return result.value;
}

describe('SPEC-010 BR-010-17/DL-010-05 — applySell, proportional', () => {
  it('AC — a sale reduces allocations proportionally and never leaves allocations exceeding holdings', async () => {
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

    // Worked example (DV-17): sale of 10, split 60/40 → 6 from retirement, 4 from trading.
    const result = await applySell(deps, USER, {
      assetId: ITSA4,
      soldQuantity: Quantity.fromString('10'),
      effectiveOn: TRADE_DATE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const retirementAlloc = (await deps.allocations.listForWallet(retirement.id))[0];
    const tradingAlloc = (await deps.allocations.listForWallet(trading.id))[0];
    expect(retirementAlloc?.quantity.toString()).toBe('54');
    expect(tradingAlloc?.quantity.toString()).toBe('36');
  });

  it('a sale exceeding the allocated total drains every wallet to zero — the remainder comes from Unassigned', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, {
      walletId: wallet.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('30'),
    });

    // 70 is unallocated; a sale of 50 can only take 30 from the wallet (all of
    // it) — the remaining 20 comes from Unassigned, which needs no adjustment.
    const result = await applySell(deps, USER, {
      assetId: ITSA4,
      soldQuantity: Quantity.fromString('50'),
      effectiveOn: TRADE_DATE,
    });
    expect(result.ok).toBe(true);
    expect(await deps.allocations.listForWallet(wallet.id)).toHaveLength(0);
  });

  it('a sale exceeding the total position quantity zeroes every wallet, not below', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('30'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });

    const result = await applySell(deps, USER, {
      assetId: ITSA4,
      soldQuantity: Quantity.fromString('30'),
      effectiveOn: TRADE_DATE,
    });
    expect(result.ok).toBe(true);
    expect(await deps.allocations.listForWallet(wallet.id)).toHaveLength(0);
  });

  it('proportional reduction with no allocations at all is a no-op', async () => {
    const deps = buildFakeDeps();
    const result = await applySell(deps, USER, {
      assetId: ITSA4,
      soldQuantity: Quantity.fromString('5'),
      effectiveOn: TRADE_DATE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});

describe('SPEC-010 BR-010-17 — applySell, specified wallet', () => {
  it('AC — a sale with a specified wallet reduces only that wallet', async () => {
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

    const result = await applySell(deps, USER, {
      assetId: ITSA4,
      soldQuantity: Quantity.fromString('15'),
      effectiveOn: TRADE_DATE,
      walletId: trading.id,
    });

    expect(result.ok).toBe(true);
    const retirementAlloc = (await deps.allocations.listForWallet(retirement.id))[0];
    const tradingAlloc = (await deps.allocations.listForWallet(trading.id))[0];
    expect(retirementAlloc?.quantity.toString()).toBe('60');
    expect(tradingAlloc?.quantity.toString()).toBe('25');
  });

  it('refuses a specified-wallet sale exceeding that wallet’s own allocation', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, {
      walletId: wallet.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('30'),
    });

    const result = await applySell(deps, USER, {
      assetId: ITSA4,
      soldQuantity: Quantity.fromString('31'),
      effectiveOn: TRADE_DATE,
      walletId: wallet.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WALLET_ALLOCATION_INSUFFICIENT');
  });

  it('deletes the allocation row when a specified-wallet sale exhausts it exactly', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, {
      walletId: wallet.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('30'),
    });

    await applySell(deps, USER, {
      assetId: ITSA4,
      soldQuantity: Quantity.fromString('30'),
      effectiveOn: TRADE_DATE,
      walletId: wallet.id,
    });
    expect(await deps.allocations.listForWallet(wallet.id)).toHaveLength(0);
  });
});

describe('applySell — validation', () => {
  it('refuses a zero or negative sold quantity', async () => {
    const deps = buildFakeDeps();
    const result = await applySell(deps, USER, {
      assetId: ITSA4,
      soldQuantity: Quantity.zero(),
      effectiveOn: TRADE_DATE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ALLOCATION_QUANTITY');
  });
});
