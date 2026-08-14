import { describe, expect, it } from 'vitest';
import { AssetId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { allocateToWallet } from '@/core/wallets/allocate';
import { applyBuy } from '@/core/wallets/apply-buy';
import { createWallet } from '@/core/wallets/create-wallet';
import { listPendingAllocations } from '@/core/wallets/pending';
import { setStandingRule } from '@/core/wallets/standing-rule';
import { buildFakeDeps } from '@/core/wallets/test-support/build-deps';

const USER = UserId.generate();
const ITSA4 = AssetId.generate();

async function walletFor(deps: ReturnType<typeof buildFakeDeps>, name: string) {
  const result = await createWallet(deps, USER, { name });
  if (!result.ok) throw new Error('setup failed');
  return result.value;
}

describe('SPEC-010 BR-010-10 — applyBuy, single-wallet asset', () => {
  it('AC — buying more of a single-wallet asset auto-increments that wallet with no user action', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });

    // The buy has already landed in the ledger and the position cache by the
    // time this runs — held quantity/average cost reflect the post-buy state.
    deps.positionQuery.set(ITSA4, Quantity.fromString('120'), Money.fromString('10.83333333'));

    const result = await applyBuy(deps, USER, {
      assetId: ITSA4,
      purchasedQuantity: Quantity.fromString('20'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_incremented');
    if (result.value.kind !== 'auto_incremented') return;
    expect(result.value.walletId).toBe(wallet.id);
    expect(result.value.allocation.quantity.toString()).toBe('120');

    const allocations = await deps.allocations.listForWallet(wallet.id);
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.quantity.toString()).toBe('120');
  });
});

describe('SPEC-010 BR-010-11/DL-010-03 — applyBuy, split asset', () => {
  it('AC — buying more of an asset split across two wallets allocates nothing', async () => {
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

    deps.positionQuery.set(ITSA4, Quantity.fromString('120'), Money.fromString('10.83333333'));
    const result = await applyBuy(deps, USER, {
      assetId: ITSA4,
      purchasedQuantity: Quantity.fromString('20'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ kind: 'pending', reason: 'ambiguous_split' });

    // Neither wallet moved — the new 20 sits in Unassigned.
    expect((await deps.allocations.listForWallet(retirement.id))[0]?.quantity.toString()).toBe(
      '60',
    );
    expect((await deps.allocations.listForWallet(trading.id))[0]?.quantity.toString()).toBe('40');

    const pending = await listPendingAllocations(deps, USER);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.unassignedQuantity.toString()).toBe('20');
    expect(pending[0]?.reason).toBe('ambiguous_split');
  });
});

describe('SPEC-010 BR-010-16 — applyBuy, brand-new asset', () => {
  it('AC — a brand-new holding lands in Unassigned, never in a wallet', async () => {
    const deps = buildFakeDeps();
    // No wallet has ever held this asset, and none exists to auto-allocate to.
    deps.positionQuery.set(ITSA4, Quantity.fromString('10'), Money.fromString('25'));

    const result = await applyBuy(deps, USER, {
      assetId: ITSA4,
      purchasedQuantity: Quantity.fromString('10'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ kind: 'pending', reason: 'no_wallet' });
    expect(await deps.allocations.listAll()).toHaveLength(0);
  });
});

describe('SPEC-010 BR-010-14/DL-010-04 — applyBuy, standing rule', () => {
  it('AC — a standing per-asset rule directs future purchases even for a split asset', async () => {
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
    await setStandingRule(deps, USER, ITSA4, trading.id);

    deps.positionQuery.set(ITSA4, Quantity.fromString('120'), Money.fromString('10.83333333'));
    const result = await applyBuy(deps, USER, {
      assetId: ITSA4,
      purchasedQuantity: Quantity.fromString('20'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('standing_rule');
    if (result.value.kind !== 'standing_rule') return;
    expect(result.value.walletId).toBe(trading.id);
    expect(result.value.allocation.quantity.toString()).toBe('60');
    // Retirement is untouched by the rule.
    expect((await deps.allocations.listForWallet(retirement.id))[0]?.quantity.toString()).toBe(
      '60',
    );
  });

  it('AC — the standing rule is off by default', async () => {
    const deps = buildFakeDeps();
    expect(await deps.assetRules.find(ITSA4)).toBeNull();
  });
});

describe('applyBuy — validation', () => {
  it('refuses a zero or negative purchased quantity', async () => {
    const deps = buildFakeDeps();
    const result = await applyBuy(deps, USER, {
      assetId: ITSA4,
      purchasedQuantity: Quantity.zero(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ALLOCATION_QUANTITY');
  });
});
