import { describe, expect, it } from 'vitest';
import { AssetId, UserId, WalletId } from '@/core/shared/ids';
import {
  clearStandingRule,
  listStandingRules,
  setStandingRule,
} from '@/core/wallets/standing-rule';
import { createWallet } from '@/core/wallets/create-wallet';
import { buildFakeDeps } from '@/core/wallets/test-support/build-deps';

const USER = UserId.generate();
const ITSA4 = AssetId.generate();
const PETR4 = AssetId.generate();

async function walletFor(deps: ReturnType<typeof buildFakeDeps>, name: string) {
  const result = await createWallet(deps, USER, { name });
  if (!result.ok) throw new Error('setup failed');
  return result.value;
}

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

/**
 * BR-010-14 / #61 — a rule you cannot see is a rule you cannot revoke.
 *
 * `clearStandingRule` was written, unit-tested, and reachable from nothing:
 * the repository could only answer `find(assetId)`, so no screen could
 * enumerate rules to render a "remove" control against. A standing instruction
 * routing every future purchase of an asset was therefore permanent by
 * accident — on a feature whose entire justification (DL-010-04) is that it is
 * opt-in.
 */
describe('listStandingRules — BR-010-14 / #61', () => {
  it('is empty by default, which is the rule being off', async () => {
    const deps = buildFakeDeps();
    expect(await listStandingRules(deps, USER)).toEqual([]);
  });

  it('lists every rule the tenant has set', async () => {
    const deps = buildFakeDeps();
    const wallet = await walletFor(deps, 'Aposentadoria');
    await setStandingRule(deps, USER, ITSA4, wallet.id);
    await setStandingRule(deps, USER, PETR4, wallet.id);

    const rules = await listStandingRules(deps, USER);

    expect(rules).toHaveLength(2);
    expect(rules.map((rule) => rule.assetId).sort()).toEqual([ITSA4, PETR4].sort());
    expect(rules.every((rule) => rule.walletId === wallet.id)).toBe(true);
  });

  it('stops listing a rule once it is cleared — the round trip #61 was missing', async () => {
    const deps = buildFakeDeps();
    const wallet = await walletFor(deps, 'Aposentadoria');
    await setStandingRule(deps, USER, ITSA4, wallet.id);
    expect(await listStandingRules(deps, USER)).toHaveLength(1);

    await clearStandingRule(deps, USER, ITSA4);

    expect(await listStandingRules(deps, USER)).toEqual([]);
  });
});
