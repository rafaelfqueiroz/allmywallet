import { describe, expect, it } from 'vitest';
import { AssetId, UserId, WalletId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { createWallet } from '@/core/wallets/create-wallet';
import { deleteWallet } from '@/core/wallets/delete-wallet';
import { allocateToWallet, computeUnassigned } from '@/core/wallets/allocate';
import { setStandingRule } from '@/core/wallets/standing-rule';
import { buildFakeDeps } from '@/core/wallets/test-support/build-deps';

const USER = UserId.generate();
const OTHER_USER = UserId.generate();
const PETR4 = AssetId.generate();

describe('SPEC-010 BR-010-07 — deleteWallet', () => {
  it('AC — deleting a wallet returns its allocations to Unassigned and deletes no transactions', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(PETR4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await createWallet(deps, USER, { name: 'Trading' });
    if (!wallet.ok) throw new Error('setup failed');
    const allocation = await allocateToWallet(deps, USER, {
      walletId: wallet.value.id,
      assetId: PETR4,
    });
    if (!allocation.ok) throw new Error('setup failed');

    const result = await deleteWallet(deps, USER, wallet.value.id);
    expect(result.ok).toBe(true);

    expect(await deps.wallets.findById(wallet.value.id)).toBeNull();
    expect(await deps.allocations.listForWallet(wallet.value.id)).toHaveLength(0);
    // "Never deletes transactions" — there is no transaction port in scope here
    // at all (BR-010-08: wallets never touch the ledger), which is the point:
    // nothing in this use case has the capability to delete one.

    const unassigned = await computeUnassigned(deps, USER);
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0]?.quantity.toString()).toBe('100');
  });

  it('clears a standing rule pointing at the deleted wallet', async () => {
    const deps = buildFakeDeps();
    const wallet = await createWallet(deps, USER, { name: 'Trading' });
    if (!wallet.ok) throw new Error('setup failed');
    await setStandingRule(deps, USER, PETR4, wallet.value.id);

    await deleteWallet(deps, USER, wallet.value.id);

    expect(await deps.assetRules.find(PETR4)).toBeNull();
  });

  it('refuses to delete another tenant’s wallet', async () => {
    const deps = buildFakeDeps();
    const wallet = await createWallet(deps, USER, { name: 'Trading' });
    if (!wallet.ok) throw new Error('setup failed');

    const result = await deleteWallet(deps, OTHER_USER, wallet.value.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WALLET_NOT_FOUND');
    expect(await deps.wallets.findById(wallet.value.id)).not.toBeNull();
  });

  it('reports not found for an unknown wallet', async () => {
    const deps = buildFakeDeps();
    const result = await deleteWallet(deps, USER, WalletId.generate());
    expect(result.ok).toBe(false);
  });
});
