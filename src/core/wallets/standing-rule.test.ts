import { describe, expect, it } from 'vitest';
import { AssetId, UserId, WalletId } from '@/core/shared/ids';
import { clearStandingRule, setStandingRule } from '@/core/wallets/standing-rule';
import { createWallet } from '@/core/wallets/create-wallet';
import { buildFakeDeps } from '@/core/wallets/test-support/build-deps';

const USER = UserId.generate();
const ITSA4 = AssetId.generate();

describe('SPEC-010 BR-010-14/DL-010-04 — standing rules', () => {
  it('AC — the standing rule is off by default', async () => {
    const deps = buildFakeDeps();
    expect(await deps.assetRules.find(ITSA4)).toBeNull();
  });

  it('sets and clears a standing rule', async () => {
    const deps = buildFakeDeps();
    const wallet = await createWallet(deps, USER, { name: 'Trading' });
    if (!wallet.ok) throw new Error('setup failed');

    const set = await setStandingRule(deps, USER, ITSA4, wallet.value.id);
    expect(set.ok).toBe(true);
    expect(await deps.assetRules.find(ITSA4)).toBe(wallet.value.id);

    const cleared = await clearStandingRule(deps, USER, ITSA4);
    expect(cleared.ok).toBe(true);
    expect(await deps.assetRules.find(ITSA4)).toBeNull();
  });

  it('refuses to point a standing rule at another tenant’s wallet', async () => {
    const deps = buildFakeDeps();
    const wallet = await createWallet(deps, USER, { name: 'Trading' });
    if (!wallet.ok) throw new Error('setup failed');

    const other = UserId.generate();
    const result = await setStandingRule(deps, other, ITSA4, wallet.value.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WALLET_NOT_FOUND');
  });

  it('reports not found for an unknown wallet', async () => {
    const deps = buildFakeDeps();
    const result = await setStandingRule(deps, USER, ITSA4, WalletId.generate());
    expect(result.ok).toBe(false);
  });
});
