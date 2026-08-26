import { describe, expect, it } from 'vitest';
import { UserId, WalletId, type AssetId } from '@/core/shared/ids';
import { AssetId as AssetIdFactory } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { AssetClass } from '@/core/quotes/ports';
import {
  buildWalletBalance,
  listWalletBalances,
  walletsNeedingAttention,
  type BalanceHolding,
} from '@/core/wallets/balance';
import { DriftUnavailableReason } from '@/core/wallets/drift';
import { createWallet } from '@/core/wallets/create-wallet';
import type { TargetMode, WalletTarget } from '@/core/wallets/targets';
import { buildFakeDeps } from '@/core/wallets/test-support/build-deps';

/**
 * SPEC-017 — the balance view, where BR-017-09, BR-017-10 and BR-017-13 meet.
 *
 * The denominator is the whole point of this file. Fixed income is excluded
 * from the targeted universe **and** from the total each current share divides
 * by; get that wrong and every share is computed against the whole wallet,
 * silently understating each variable-income position — which is the one bug
 * that would make the feature actively misleading rather than merely wrong.
 */

const WALLET = WalletId.generate();
const PETR = AssetIdFactory.generate();
const VALE = AssetIdFactory.generate();
const ITSA = AssetIdFactory.generate();
const BBAS = AssetIdFactory.generate();
const CDB = AssetIdFactory.generate();

function holding(
  assetId: AssetId,
  assetClass: AssetClass,
  value: string,
  quantity = '10',
  priceUsable = true,
): BalanceHolding {
  return {
    assetId,
    assetClass,
    quantity: Quantity.fromString(quantity),
    value: Money.fromString(value),
    priceUsable,
  };
}

function build(
  mode: TargetMode,
  holdings: readonly BalanceHolding[],
  stored: readonly WalletTarget[] = [],
  tolerance = '5',
) {
  return buildWalletBalance({
    wallet: { id: WALLET, name: 'Aposentadoria', targetMode: mode },
    stored,
    holdings,
    tolerancePp: Quantity.fromString(tolerance),
  });
}

describe('BR-017-09/10/13 / AC-6 — fixed income is excluded, and the exclusion is stated', () => {
  /**
   * AC-6 exactly: a wallet holding a CDB and four stocks shows targets over
   * the four stocks only, and states what percentage of the wallet those
   * targets cover.
   *
   * By hand: four stocks at R$ 150 each = R$ 600; the CDB is R$ 400; the
   * wallet is R$ 1.000.
   *   targeted value    600
   *   each stock's share 150 ÷ 600 × 100 = 25 %  (the last takes the residual,
   *                                               which here is exactly 25)
   *   targeted share     600 ÷ 1.000 × 100 = 60 %
   *
   * The trap this catches: dividing by 1.000 instead of 600 gives each stock
   * 15 %, so four assets on target would each read 10 pp underweight and the
   * wallet would scream for attention over nothing.
   */
  it('computes every share over the targeted value, not the wallet value', () => {
    const balance = build('equal_weight', [
      holding(PETR, 'stock', '150'),
      holding(VALE, 'stock', '150'),
      holding(ITSA, 'stock', '150'),
      holding(BBAS, 'stock', '150'),
      holding(CDB, 'cdb', '400'),
    ]);

    expect(balance.rows).toHaveLength(4);
    expect(balance.rows.map((row) => row.currentPct?.toString())).toEqual(['25', '25', '25', '25']);
    expect(balance.rows.map((row) => row.targetPct.toString())).toEqual(['25', '25', '25', '25']);
    expect(balance.rows.every((row) => row.driftPp?.isZero())).toBe(true);
    expect(balance.outOfBalance).toBe(false);

    expect(balance.targetedValue.toString()).toBe('600');
    expect(balance.walletValue.toString()).toBe('1000');
    expect(balance.targetedSharePct?.toString()).toBe('60');
  });

  it('lists the untargeted holdings rather than leaving them to be inferred', () => {
    const balance = build('equal_weight', [
      holding(PETR, 'stock', '600'),
      holding(CDB, 'cdb', '400'),
    ]);

    expect(balance.untargeted.map((row) => row.assetId)).toEqual([CDB]);
    expect(balance.untargeted[0]?.value.toString()).toBe('400');
  });

  it('excludes Tesouro Direto with the bank paper', () => {
    const tesouro = AssetIdFactory.generate();
    const balance = build('equal_weight', [
      holding(PETR, 'stock', '500'),
      holding(tesouro, 'tesouro_direto', '500'),
    ]);

    expect(balance.rows).toHaveLength(1);
    expect(balance.targetedValue.toString()).toBe('500');
    expect(balance.targetedSharePct?.toString()).toBe('50');
  });

  it('says the targets cover everything when nothing is excluded', () => {
    const balance = build('equal_weight', [
      holding(PETR, 'stock', '500'),
      holding(VALE, 'fii', '500'),
    ]);
    expect(balance.untargeted).toEqual([]);
    expect(balance.targetedSharePct?.toString()).toBe('100');
  });

  it('BR-017-11 / AC-7 — a wallet holding only fixed income reports nothing targetable', () => {
    const balance = build('none', [holding(CDB, 'cdb', '1000')]);

    expect(balance.hasTargetableAssets).toBe(false);
    expect(balance.rows).toEqual([]);
    expect(balance.targetedValue.toString()).toBe('0');
    expect(balance.targetedSharePct?.toString()).toBe('0');
  });

  it('withholds the coverage figure for a wallet worth nothing rather than reporting 0 %', () => {
    const balance = build('equal_weight', [holding(PETR, 'stock', '0')]);
    expect(balance.targetedSharePct).toBeNull();
    expect(balance.unavailableReason).toBe(DriftUnavailableReason.NO_TARGETED_VALUE);
  });
});

describe('BR-017-18 — the gap, per row', () => {
  it('carries all three figures for an overweight and an underweight asset in one wallet', () => {
    /*
     *   targeted value  1.000
     *   PETR4  R$ 700 over 10 cotas → 70 %, target 50 % → gap −20 pp,
     *          −R$ 200, −2,857… cotas at R$ 70 → −2 tradable
     *   VALE3  R$ 300 over 10 cotas → 30 %, target 50 % → gap +20 pp,
     *          +R$ 200, +6,666… cotas at R$ 30 → +6 tradable
     */
    const balance = build(
      'manual',
      [holding(PETR, 'stock', '700'), holding(VALE, 'stock', '300')],
      [
        { assetId: PETR, targetPct: Quantity.fromString('50') },
        { assetId: VALE, targetPct: Quantity.fromString('50') },
      ],
    );

    const byAsset = new Map(balance.rows.map((row) => [row.assetId, row]));
    const petr = byAsset.get(PETR);
    const vale = byAsset.get(VALE);

    expect(petr?.gap?.gapValue.toString()).toBe('-200');
    expect(petr?.gap?.tradableShares?.toString()).toBe('-2');
    expect(vale?.gap?.gapValue.toString()).toBe('200');
    expect(vale?.gap?.tradableShares?.toString()).toBe('6');
  });

  it('BR-017-21 — no gap is offered while the drift is unavailable', () => {
    const balance = build('equal_weight', [
      holding(PETR, 'stock', '700'),
      holding(VALE, 'stock', '300', '10', false),
    ]);

    expect(balance.unavailableReason).toBe(DriftUnavailableReason.PRICE_UNUSABLE);
    expect(balance.unpricedAssetIds).toEqual([VALE]);
    expect(balance.rows.every((row) => row.gap === null)).toBe(true);
    expect(balance.outOfBalance).toBe(false);
  });
});

describe('the row order is stable, because the residual rides on the last one', () => {
  it('produces identical figures whatever order the holdings arrive in', () => {
    const holdings = [
      holding(PETR, 'stock', '100'),
      holding(VALE, 'stock', '100'),
      holding(ITSA, 'stock', '100'),
    ];
    const forwards = build('equal_weight', holdings);
    const backwards = build('equal_weight', [...holdings].reverse());

    expect(backwards.rows.map((row) => `${row.assetId}:${row.currentPct?.toString()}`)).toEqual(
      forwards.rows.map((row) => `${row.assetId}:${row.currentPct?.toString()}`),
    );
  });
});

describe('BR-017-07 — needsReview travels with the balance', () => {
  it('flags a manual wallet holding something whose weight was never stated', () => {
    const balance = build(
      'manual',
      [holding(PETR, 'stock', '600'), holding(VALE, 'stock', '400')],
      [{ assetId: PETR, targetPct: Quantity.fromString('100') }],
    );

    expect(balance.needsReview).toBe(true);
    expect(balance.unsetAssetIds).toEqual([VALE]);
  });

  it('does not flag an equal-weight wallet, whatever its asset set does', () => {
    const balance = build('equal_weight', [
      holding(PETR, 'stock', '600'),
      holding(VALE, 'stock', '400'),
    ]);
    expect(balance.needsReview).toBe(false);
  });
});

describe('BR-017-16/17 / AC-10 — the sweep behind the existing queue', () => {
  const USER = UserId.generate();

  async function twoWallets() {
    const deps = buildFakeDeps();
    const first = await createWallet(deps, USER, { name: 'Aposentadoria' });
    const second = await createWallet(deps, USER, { name: 'Trading' });
    if (!first.ok || !second.ok) throw new Error('setup failed');
    return { deps, first: first.value, second: second.value };
  }

  it('computes one balance per wallet, including a wallet holding nothing', async () => {
    const { deps, first, second } = await twoWallets();
    await deps.wallets.update({ ...first, targetMode: 'equal_weight' });

    const balances = await listWalletBalances(deps, USER, {
      holdingsByWallet: new Map([
        [first.id, [holding(PETR, 'stock', '700'), holding(VALE, 'stock', '300')]],
      ]),
      tolerancePp: Quantity.fromString('5'),
    });

    expect(balances).toHaveLength(2);
    const empty = balances.find((balance) => balance.walletId === second.id);
    expect(empty?.rows).toEqual([]);
    expect(empty?.hasTargetableAssets).toBe(false);
  });

  it('reads each wallet’s stored targets, and only its own', async () => {
    const { deps, first, second } = await twoWallets();
    await deps.wallets.update({ ...first, targetMode: 'manual' });
    await deps.wallets.update({ ...second, targetMode: 'manual' });
    deps.targets.seed(
      { walletId: first.id, assetId: PETR, targetPct: Quantity.fromString('100') },
      { walletId: second.id, assetId: VALE, targetPct: Quantity.fromString('100') },
    );

    const balances = await listWalletBalances(deps, USER, {
      holdingsByWallet: new Map([
        [first.id, [holding(PETR, 'stock', '1000')]],
        [second.id, [holding(VALE, 'stock', '1000')]],
      ]),
      tolerancePp: Quantity.fromString('5'),
    });

    for (const balance of balances) {
      expect(balance.rows).toHaveLength(1);
      expect(balance.needsReview).toBe(false);
    }
  });

  it('AC-10 — an out-of-balance wallet and one needing review both reach the queue', async () => {
    const { deps, first, second } = await twoWallets();
    await deps.wallets.update({ ...first, targetMode: 'equal_weight' });
    await deps.wallets.update({ ...second, targetMode: 'manual' });
    deps.targets.seed({
      walletId: second.id,
      assetId: PETR,
      targetPct: Quantity.fromString('100'),
    });

    const balances = await listWalletBalances(deps, USER, {
      holdingsByWallet: new Map([
        // 90/10 against a 50/50 equal-weight target: 40 pp out.
        [first.id, [holding(PETR, 'stock', '900'), holding(VALE, 'stock', '100')]],
        // On target, but holding something whose weight was never stated.
        [second.id, [holding(PETR, 'stock', '1000'), holding(VALE, 'stock', '0')]],
      ]),
      tolerancePp: Quantity.fromString('5'),
    });

    const queue = walletsNeedingAttention(balances);
    expect(queue.map((balance) => balance.walletId).sort()).toEqual([first.id, second.id].sort());
    expect(queue.find((b) => b.walletId === first.id)?.outOfBalance).toBe(true);
    expect(queue.find((b) => b.walletId === second.id)?.needsReview).toBe(true);
  });

  it('leaves a balanced wallet out of the queue', async () => {
    const { deps, first } = await twoWallets();
    await deps.wallets.update({ ...first, targetMode: 'equal_weight' });

    const balances = await listWalletBalances(deps, USER, {
      holdingsByWallet: new Map([
        [first.id, [holding(PETR, 'stock', '500'), holding(VALE, 'stock', '500')]],
      ]),
      tolerancePp: Quantity.fromString('5'),
    });

    expect(walletsNeedingAttention(balances.filter((b) => b.walletId === first.id))).toEqual([]);
  });

  /**
   * AC-15 / BR-017-25 — editing a target changes only what this view shows.
   *
   * Nothing here writes, and nothing anywhere reads a target when producing a
   * historical figure: `daily_valuation_snapshots`, the position cache and the
   * allocation event log are all computed without one. The structural proof is
   * that `wallet_targets` has exactly one reader — this module — so the same
   * holdings under two different target sets produce two different balance
   * views and identical everything else.
   */
  it('AC-15 — the same holdings under two target sets differ only in the balance figures', () => {
    const holdings = [holding(PETR, 'stock', '700'), holding(VALE, 'stock', '300')];
    const before = build('manual', holdings, [
      { assetId: PETR, targetPct: Quantity.fromString('50') },
      { assetId: VALE, targetPct: Quantity.fromString('50') },
    ]);
    const after = build('manual', holdings, [
      { assetId: PETR, targetPct: Quantity.fromString('70') },
      { assetId: VALE, targetPct: Quantity.fromString('30') },
    ]);

    expect(after.walletValue.equals(before.walletValue)).toBe(true);
    expect(after.targetedValue.equals(before.targetedValue)).toBe(true);
    expect(after.rows.map((row) => row.currentPct?.toString())).toEqual(
      before.rows.map((row) => row.currentPct?.toString()),
    );
    expect(before.outOfBalance).toBe(true);
    expect(after.outOfBalance).toBe(false);
  });
});
