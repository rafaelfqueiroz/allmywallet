import { describe, expect, it } from 'vitest';
import { AssetId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { allocateToWallet } from '@/core/wallets/allocate';
import { createWallet } from '@/core/wallets/create-wallet';
import { listPendingAllocations } from '@/core/wallets/pending';
import { buildFakeDeps } from '@/core/wallets/test-support/build-deps';

const USER = UserId.generate();
const ITSA4 = AssetId.generate();
const VALE3 = AssetId.generate();

async function walletFor(deps: ReturnType<typeof buildFakeDeps>, name: string) {
  const result = await createWallet(deps, USER, { name });
  if (!result.ok) throw new Error('setup failed');
  return result.value;
}

describe('SPEC-010 BR-010-12 — listPendingAllocations ("Needs attention")', () => {
  it('a brand-new, never-allocated holding is pending with reason no_wallet', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('10'), Money.fromString('25'));

    const pending = await listPendingAllocations(deps, USER);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.reason).toBe('no_wallet');
    expect(pending[0]?.unassignedQuantity.toString()).toBe('10');
  });

  it('a split asset with an unassigned remainder is pending with reason ambiguous_split', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('120'), Money.fromString('10'));
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

    const pending = await listPendingAllocations(deps, USER);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.reason).toBe('ambiguous_split');
    expect(pending[0]?.unassignedQuantity.toString()).toBe('20');
  });

  it('a fully allocated single-wallet asset is not pending', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('50'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });

    expect(await listPendingAllocations(deps, USER)).toHaveLength(0);
  });

  it('lists one entry per pending asset, ignoring assets with nothing held', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('10'), Money.fromString('25'));
    deps.positionQuery.set(VALE3, Quantity.fromString('5'), Money.fromString('60'));

    const pending = await listPendingAllocations(deps, USER);
    expect(pending.map((p) => p.assetId).sort()).toEqual([ITSA4, VALE3].sort());
  });
});
