import { describe, expect, it } from 'vitest';
import { AssetId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { allocateToWallet } from '@/core/wallets/allocate';
import { compareWallets } from '@/core/wallets/compare-wallets';
import { createWallet } from '@/core/wallets/create-wallet';
import { buildFakeDeps } from '@/core/wallets/test-support/build-deps';

const USER = UserId.generate();
const ITSA4 = AssetId.generate();

describe('SPEC-010 BR-010-21 — compareWallets', () => {
  it('summarises allocated quantity and cost basis per wallet, side by side', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const retirement = await createWallet(deps, USER, { name: 'Aposentadoria' });
    const trading = await createWallet(deps, USER, { name: 'Trading' });
    if (!retirement.ok || !trading.ok) throw new Error('setup failed');
    await allocateToWallet(deps, USER, {
      walletId: retirement.value.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('60'),
    });
    await allocateToWallet(deps, USER, {
      walletId: trading.value.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('40'),
    });

    const rows = await compareWallets(deps, USER);
    expect(rows).toHaveLength(2);
    const retirementRow = rows.find((r) => r.wallet.id === retirement.value.id);
    const tradingRow = rows.find((r) => r.wallet.id === trading.value.id);
    expect(retirementRow?.totalQuantity.toString()).toBe('60');
    expect(retirementRow?.totalCostBasis.toString()).toBe('600');
    expect(tradingRow?.totalQuantity.toString()).toBe('40');
    expect(tradingRow?.totalCostBasis.toString()).toBe('400');
  });

  it('a wallet with no allocations reports zero', async () => {
    const deps = buildFakeDeps();
    const wallet = await createWallet(deps, USER, { name: 'Empty' });
    if (!wallet.ok) throw new Error('setup failed');

    const rows = await compareWallets(deps, USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.assetCount).toBe(0);
    expect(rows[0]?.totalCostBasis.isZero()).toBe(true);
    expect(rows[0]?.costEstimated).toBe(false);
  });

  it('SPEC-007 BR-007-06 / DL-007-12 — marks a wallet holding an estimated-cost position, and only that one', async () => {
    const deps = buildFakeDeps();
    const PETR4 = AssetId.generate();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'), true);
    deps.positionQuery.set(PETR4, Quantity.fromString('50'), Money.fromString('20'), false);
    const withEstimate = await createWallet(deps, USER, { name: 'Com estimativa' });
    const exact = await createWallet(deps, USER, { name: 'Exata' });
    if (!withEstimate.ok || !exact.ok) throw new Error('setup failed');
    await allocateToWallet(deps, USER, {
      walletId: withEstimate.value.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('100'),
    });
    await allocateToWallet(deps, USER, {
      walletId: exact.value.id,
      assetId: PETR4,
      quantity: Quantity.fromString('50'),
    });

    const rows = await compareWallets(deps, USER);
    expect(rows.find((r) => r.wallet.id === withEstimate.value.id)?.costEstimated).toBe(true);
    expect(rows.find((r) => r.wallet.id === exact.value.id)?.costEstimated).toBe(false);
  });
});
