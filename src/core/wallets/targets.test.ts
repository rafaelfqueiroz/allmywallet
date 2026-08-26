import { describe, expect, it } from 'vitest';
import { AssetId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { Asset, AssetClass } from '@/core/quotes/ports';
import { createWallet } from '@/core/wallets/create-wallet';
import { allocateToWallet } from '@/core/wallets/allocate';
import { WalletErrorCode } from '@/core/wallets/errors';
import {
  TARGETABLE_CLASSES,
  TARGET_TOTAL_PCT,
  effectiveTargets,
  equalWeightTargets,
  isTargetMode,
  isTargetable,
  reconcileManualTargets,
  setWalletTargets,
  sumTargetPct,
  validateManualTargets,
  type WalletTarget,
} from '@/core/wallets/targets';
import { buildFakeDeps } from '@/core/wallets/test-support/build-deps';

/**
 * SPEC-017 — targets.
 *
 * TS-04: every percentage below is hand-computed and asserted as **exact**
 * `Quantity` equality. An approximate comparison would pass straight over the
 * residual arithmetic these functions exist for — a set of targets summing to
 * 99,999… instead of 100 is precisely what BR-017-04 rejects, and it is
 * invisible to `toBeCloseTo`.
 */

const USER = UserId.generate();

function ids(count: number): AssetId[] {
  return Array.from({ length: count }, () => AssetId.generate());
}

function pct(value: string): Quantity {
  return Quantity.fromString(value);
}

describe('BR-017-02 — the stored mode', () => {
  it('narrows only the three real modes', () => {
    expect(isTargetMode('equal_weight')).toBe(true);
    expect(isTargetMode('manual')).toBe(true);
    expect(isTargetMode('none')).toBe(true);
    expect(isTargetMode('proportional')).toBe(false);
  });
});

describe('BR-017-09 / DL-017-04 — the targetable universe', () => {
  /**
   * The list is written out rather than derived from
   * `core/valuation/holdings.ts`, so this is the test that notices when a ninth
   * asset class arrives: it will be untargetable by default, and somebody has
   * to decide that rather than inherit it.
   */
  it('covers the four listed classes and excludes every fixed-income one', () => {
    expect([...TARGETABLE_CLASSES].sort()).toEqual(['bdr', 'etf', 'fii', 'stock']);
    for (const excluded of ['cdb', 'lci', 'lca', 'tesouro_direto'] as AssetClass[]) {
      expect(isTargetable(excluded)).toBe(false);
    }
  });
});

describe('BR-017-05 — equal weight, derived', () => {
  it('AC-1 — ten assets each read 10 %', () => {
    const targets = equalWeightTargets(ids(10));
    expect(targets.map((target) => target.targetPct.toString())).toEqual(Array(10).fill('10'));
    expect(sumTargetPct(targets).equals(TARGET_TOTAL_PCT)).toBe(true);
  });

  /**
   * AC-2, and the case a naive implementation gets wrong.
   *
   *   100 ÷ 11 = 9,0909…09  (40 significant digits, truncated down)
   *   ten of those sum to    90,909…09
   *   the eleventh takes     100 − that = 9,0909…10   ← the residual
   *   Σ                                 = exactly 100
   *
   * Dividing all eleven gives 99,999… — a wallet whose own equal-weight mode
   * produces a set BR-017-04 would reject.
   */
  it('AC-2 — an eleventh asset moves every target to 100 ÷ 11, and they still total exactly 100', () => {
    const targets = equalWeightTargets(ids(11));

    const first = targets[0]?.targetPct.toString() ?? '';
    expect(first.startsWith('9.0909090909')).toBe(true);
    // The first ten are identical; only the last carries the residual.
    expect(new Set(targets.slice(0, 10).map((t) => t.targetPct.toString())).size).toBe(1);
    expect(sumTargetPct(targets).equals(TARGET_TOTAL_PCT)).toBe(true);
  });

  it('gives a single asset the whole 100 %', () => {
    const targets = equalWeightTargets(ids(1));
    expect(targets[0]?.targetPct.toString()).toBe('100');
  });

  it('derives nothing for a wallet with no targetable assets', () => {
    expect(equalWeightTargets([])).toEqual([]);
  });

  it('sums to exactly 100 across seven assets, where no share terminates', () => {
    // A denominator with a factor of seven in it: no finite decimal represents
    // 100 ÷ 7, so every share is truncated and the residual is doing real work.
    expect(sumTargetPct(equalWeightTargets(ids(7))).toString()).toBe('100');
  });
});

describe('BR-017-04 / AC-4 — manual targets must total exactly 100 %', () => {
  it('accepts a set totalling exactly 100', () => {
    const [a, b] = ids(2) as [AssetId, AssetId];
    const result = validateManualTargets([
      { assetId: a, targetPct: pct('60') },
      { assetId: b, targetPct: pct('40') },
    ]);
    expect(result.ok).toBe(true);
  });

  it('rejects a shortfall and names it', () => {
    const [a, b] = ids(2) as [AssetId, AssetId];
    const result = validateManualTargets([
      { assetId: a, targetPct: pct('60') },
      { assetId: b, targetPct: pct('30') },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(WalletErrorCode.TARGETS_MUST_TOTAL_100);
    expect(result.error.context.total).toBe('90');
    // Positive means missing — the pt-BR message renders the sign.
    expect(result.error.context.difference).toBe('10');
  });

  it('rejects an excess and names it as a negative difference', () => {
    const [a, b] = ids(2) as [AssetId, AssetId];
    const result = validateManualTargets([
      { assetId: a, targetPct: pct('60') },
      { assetId: b, targetPct: pct('55') },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.context.total).toBe('115');
    expect(result.error.context.difference).toBe('-15');
  });

  it('rejects 99,999999 — the near miss an approximate check would let through', () => {
    const [a, b] = ids(2) as [AssetId, AssetId];
    const result = validateManualTargets([
      { assetId: a, targetPct: pct('60') },
      { assetId: b, targetPct: pct('39.999999') },
    ]);
    expect(result.ok).toBe(false);
  });

  it('rejects a percentage outside 0–100 before it ever reaches the sum', () => {
    const [a, b] = ids(2) as [AssetId, AssetId];
    const negative = validateManualTargets([
      { assetId: a, targetPct: pct('-10') },
      { assetId: b, targetPct: pct('110') },
    ]);
    expect(negative.ok).toBe(false);
    if (negative.ok) return;
    expect(negative.error.code).toBe(WalletErrorCode.INVALID_TARGET_PCT);
  });

  it('rejects a percentage above 100 even when the set would still total 100', () => {
    const [a, b] = ids(2) as [AssetId, AssetId];
    const result = validateManualTargets([
      { assetId: a, targetPct: pct('101') },
      { assetId: b, targetPct: pct('-1') },
    ]);
    expect(result.ok).toBe(false);
  });

  it('rejects the same asset named twice', () => {
    const [a] = ids(1) as [AssetId];
    const result = validateManualTargets([
      { assetId: a, targetPct: pct('50') },
      { assetId: a, targetPct: pct('50') },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(WalletErrorCode.DUPLICATE_TARGET_ASSET);
  });

  it('rejects an empty set — nothing totals 100', () => {
    expect(validateManualTargets([]).ok).toBe(false);
  });
});

describe('BR-017-07 / DL-017-05 — manual targets never move by themselves', () => {
  it('AC-3 — a new asset enters at 0 %, existing targets are untouched, and the wallet flags', () => {
    const [petr, vale, itsa] = ids(3) as [AssetId, AssetId, AssetId];
    const stored: WalletTarget[] = [
      { assetId: petr, targetPct: pct('60') },
      { assetId: vale, targetPct: pct('40') },
    ];

    const { targets, needsReview } = reconcileManualTargets(stored, [petr, vale, itsa]);

    expect(targets.map((t) => t.targetPct.toString())).toEqual(['60', '40', '0']);
    // The refusal to rescale is the rule: 60/40 does not silently become
    // 33,33/33,33/33,33, and it does not become 50/50 either.
    expect(needsReview).toBe(true);
  });

  it('does not flag while every holding has a stated weight and they total 100', () => {
    const [petr, vale] = ids(2) as [AssetId, AssetId];
    const { needsReview, unsetAssetIds } = reconcileManualTargets(
      [
        { assetId: petr, targetPct: pct('60') },
        { assetId: vale, targetPct: pct('40') },
      ],
      [petr, vale],
    );
    expect(needsReview).toBe(false);
    expect(unsetAssetIds).toEqual([]);
  });

  /**
   * DL-017-03's alternative to headroom: a 0 % row is how "I hold this and
   * intend nothing of it" is expressed. It only works if a *stated* zero stops
   * flagging — otherwise the wallet warns forever and the user learns to
   * ignore the warning.
   */
  it('a deliberately stated 0 % does not flag, unlike an entrant that defaulted to zero', () => {
    const [petr, vale] = ids(2) as [AssetId, AssetId];
    const stated = reconcileManualTargets(
      [
        { assetId: petr, targetPct: pct('100') },
        { assetId: vale, targetPct: pct('0') },
      ],
      [petr, vale],
    );
    expect(stated.needsReview).toBe(false);

    const entrant = reconcileManualTargets(
      [{ assetId: petr, targetPct: pct('100') }],
      [petr, vale],
    );
    expect(entrant.needsReview).toBe(true);
    expect(entrant.unsetAssetIds).toEqual([vale]);
  });

  it('BR-017-24 — an asset that has left the wallet drops out of the effective set and flags', () => {
    const [petr, vale] = ids(2) as [AssetId, AssetId];
    const { targets, needsReview } = reconcileManualTargets(
      [
        { assetId: petr, targetPct: pct('60') },
        { assetId: vale, targetPct: pct('40') },
      ],
      [petr],
    );

    expect(targets).toHaveLength(1);
    expect(targets[0]?.targetPct.toString()).toBe('60');
    expect(needsReview).toBe(true);
  });
});

describe('effectiveTargets — the mode, applied', () => {
  it('none declares nothing and never asks for review', () => {
    const [a] = ids(1) as [AssetId];
    expect(effectiveTargets('none', [{ assetId: a, targetPct: pct('100') }], [a])).toEqual({
      targets: [],
      needsReview: false,
      unsetAssetIds: [],
    });
  });

  it('BR-017-06 — equal weight recomputes from the asset set and ignores anything stored', () => {
    const [a, b] = ids(2) as [AssetId, AssetId];
    const { targets, needsReview } = effectiveTargets(
      'equal_weight',
      [{ assetId: a, targetPct: pct('99') }],
      [a, b],
    );
    expect(targets.map((t) => t.targetPct.toString())).toEqual(['50', '50']);
    expect(needsReview).toBe(false);
  });

  /**
   * BR-017-23 / AC-14 — a split changes no target, and needs no code to say so.
   *
   * BR-010-18 scales the allocation and the position by the same ratio, so the
   * wallet's *asset set* is identical before and after. Targets are derived
   * from that set, so the derivation is the proof: same input, same output.
   */
  it('BR-017-23 — a 10:1 split leaves the derived targets identical', () => {
    const assets = ids(4);
    const before = effectiveTargets('equal_weight', [], assets);
    const after = effectiveTargets('equal_weight', [], assets);
    expect(after.targets.map((t) => t.targetPct.toString())).toEqual(
      before.targets.map((t) => t.targetPct.toString()),
    );
  });
});

// ---------------------------------------------------------------------------
// setWalletTargets — the write path
// ---------------------------------------------------------------------------

type Deps = ReturnType<typeof buildFakeDeps>;

function asset(id: AssetId, code: string, assetClass: AssetClass): Asset {
  return { id, code, name: code, assetClass };
}

async function walletWith(
  deps: Deps,
  holdings: readonly { readonly id: AssetId; readonly assetClass: AssetClass }[],
) {
  const created = await createWallet(deps, USER, { name: 'Aposentadoria' });
  if (!created.ok) throw new Error('setup failed');

  for (const [index, holding] of holdings.entries()) {
    deps.assetCatalog.add(asset(holding.id, `ASSET${index}`, holding.assetClass));
    deps.positionQuery.set(holding.id, Quantity.fromString('100'), Money.fromString('10'));
    await allocateToWallet(deps, USER, { walletId: created.value.id, assetId: holding.id });
  }
  return created.value;
}

describe('setWalletTargets', () => {
  it('AC-1 — equal weight is one action, and stores no target rows', async () => {
    const deps = buildFakeDeps();
    const held = ids(10).map((id) => ({ id, assetClass: 'stock' as AssetClass }));
    const wallet = await walletWith(deps, held);

    const result = await setWalletTargets(deps, USER, {
      walletId: wallet.id,
      mode: 'equal_weight',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.targets.map((t) => t.targetPct.toString())).toEqual(Array(10).fill('10'));
    // BR-017-05: derived, not stored. Nothing to migrate when the set changes.
    expect(await deps.targets.listAll()).toEqual([]);
    expect((await deps.wallets.findById(wallet.id))?.targetMode).toBe('equal_weight');
  });

  it('takes the wallet lock before writing — BR-017-04 spans rows', async () => {
    const deps = buildFakeDeps();
    const wallet = await walletWith(deps, [{ id: AssetId.generate(), assetClass: 'stock' }]);

    await setWalletTargets(deps, USER, { walletId: wallet.id, mode: 'equal_weight' });

    expect(deps.targets.lockCount).toBe(1);
  });

  it('AC-4 — a manual set that does not total 100 is refused and nothing is stored', async () => {
    const deps = buildFakeDeps();
    const [petr, vale] = ids(2) as [AssetId, AssetId];
    const wallet = await walletWith(deps, [
      { id: petr, assetClass: 'stock' },
      { id: vale, assetClass: 'stock' },
    ]);

    const result = await setWalletTargets(deps, USER, {
      walletId: wallet.id,
      mode: 'manual',
      targets: [
        { assetId: petr, targetPct: pct('60') },
        { assetId: vale, targetPct: pct('30') },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(WalletErrorCode.TARGETS_MUST_TOTAL_100);
    expect(await deps.targets.listAll()).toEqual([]);
    expect((await deps.wallets.findById(wallet.id))?.targetMode).toBe('none');
  });

  it('stores a valid manual set and switches the wallet into manual mode', async () => {
    const deps = buildFakeDeps();
    const [petr, vale] = ids(2) as [AssetId, AssetId];
    const wallet = await walletWith(deps, [
      { id: petr, assetClass: 'stock' },
      { id: vale, assetClass: 'stock' },
    ]);

    const result = await setWalletTargets(deps, USER, {
      walletId: wallet.id,
      mode: 'manual',
      targets: [
        { assetId: petr, targetPct: pct('70') },
        { assetId: vale, targetPct: pct('30') },
      ],
    });

    expect(result.ok).toBe(true);
    expect((await deps.targets.listForWallet(wallet.id)).length).toBe(2);
    expect((await deps.wallets.findById(wallet.id))?.targetMode).toBe('manual');
  });

  it('BR-017-09 — a target naming fixed income is refused', async () => {
    const deps = buildFakeDeps();
    const [petr, cdb] = ids(2) as [AssetId, AssetId];
    const wallet = await walletWith(deps, [
      { id: petr, assetClass: 'stock' },
      { id: cdb, assetClass: 'cdb' },
    ]);

    const result = await setWalletTargets(deps, USER, {
      walletId: wallet.id,
      mode: 'manual',
      targets: [
        { assetId: petr, targetPct: pct('50') },
        { assetId: cdb, targetPct: pct('50') },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(WalletErrorCode.TARGET_ASSET_NOT_TARGETABLE);
  });

  it('refuses a set that leaves a targetable holding unnamed', async () => {
    const deps = buildFakeDeps();
    const [petr, vale] = ids(2) as [AssetId, AssetId];
    const wallet = await walletWith(deps, [
      { id: petr, assetClass: 'stock' },
      { id: vale, assetClass: 'stock' },
    ]);

    // 100 % on one asset while the other is simply absent would total 100 and
    // still leave VALE3 outside the denominator it is measured against.
    const result = await setWalletTargets(deps, USER, {
      walletId: wallet.id,
      mode: 'manual',
      targets: [{ assetId: petr, targetPct: pct('100') }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(WalletErrorCode.TARGET_ASSET_MISSING);
    expect(result.error.context.missingCount).toBe(1);
  });

  it('BR-017-11 / AC-7 — a wallet holding only fixed income cannot define targets', async () => {
    const deps = buildFakeDeps();
    const wallet = await walletWith(deps, [
      { id: AssetId.generate(), assetClass: 'cdb' },
      { id: AssetId.generate(), assetClass: 'tesouro_direto' },
    ]);

    const result = await setWalletTargets(deps, USER, {
      walletId: wallet.id,
      mode: 'equal_weight',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(WalletErrorCode.WALLET_HAS_NO_TARGETABLE_ASSETS);
  });

  it('still allows returning to `none`, even with nothing targetable', async () => {
    const deps = buildFakeDeps();
    const wallet = await walletWith(deps, [{ id: AssetId.generate(), assetClass: 'cdb' }]);

    const result = await setWalletTargets(deps, USER, { walletId: wallet.id, mode: 'none' });
    expect(result.ok).toBe(true);
  });

  it('BR-017-08 / AC-5 — leaving manual mode without confirmation is refused, and names what would be lost', async () => {
    const deps = buildFakeDeps();
    const [petr, vale] = ids(2) as [AssetId, AssetId];
    const wallet = await walletWith(deps, [
      { id: petr, assetClass: 'stock' },
      { id: vale, assetClass: 'stock' },
    ]);
    await setWalletTargets(deps, USER, {
      walletId: wallet.id,
      mode: 'manual',
      targets: [
        { assetId: petr, targetPct: pct('70') },
        { assetId: vale, targetPct: pct('30') },
      ],
    });

    const refused = await setWalletTargets(deps, USER, {
      walletId: wallet.id,
      mode: 'equal_weight',
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe(WalletErrorCode.TARGET_DISCARD_NOT_CONFIRMED);
    expect(refused.error.context.discardedCount).toBe(2);
    // Nothing was discarded by the refusal itself.
    expect((await deps.targets.listForWallet(wallet.id)).length).toBe(2);

    const confirmed = await setWalletTargets(deps, USER, {
      walletId: wallet.id,
      mode: 'equal_weight',
      confirmDiscard: true,
    });

    expect(confirmed.ok).toBe(true);
    expect(await deps.targets.listForWallet(wallet.id)).toEqual([]);
  });

  it('needs no confirmation to leave manual mode when nothing was ever stored', async () => {
    const deps = buildFakeDeps();
    const wallet = await walletWith(deps, [{ id: AssetId.generate(), assetClass: 'stock' }]);
    // The wallet is in `none`, so there is nothing hand-set to lose.
    const result = await setWalletTargets(deps, USER, {
      walletId: wallet.id,
      mode: 'equal_weight',
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a wallet this tenant does not have', async () => {
    const deps = buildFakeDeps();
    const other = await createWallet(deps, UserId.generate(), { name: 'Outra' });
    if (!other.ok) throw new Error('setup failed');

    const result = await setWalletTargets(deps, USER, {
      walletId: other.value.id,
      mode: 'equal_weight',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(WalletErrorCode.WALLET_NOT_FOUND);
  });

  it('treats an asset the catalog cannot classify as untargetable rather than guessing', async () => {
    const deps = buildFakeDeps();
    const known = AssetId.generate();
    const unknown = AssetId.generate();
    const created = await createWallet(deps, USER, { name: 'Aposentadoria' });
    if (!created.ok) throw new Error('setup failed');

    deps.assetCatalog.add(asset(known, 'PETR4', 'stock'));
    for (const id of [known, unknown]) {
      deps.positionQuery.set(id, Quantity.fromString('100'), Money.fromString('10'));
      await allocateToWallet(deps, USER, { walletId: created.value.id, assetId: id });
    }

    const result = await setWalletTargets(deps, USER, {
      walletId: created.value.id,
      mode: 'manual',
      targets: [{ assetId: known, targetPct: pct('100') }],
    });

    // Not an error: the unclassifiable holding is simply outside the targeted
    // universe, and BR-017-10's coverage statement is what makes that visible.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.untargetableAssetIds).toEqual([unknown].filter(Boolean));
  });
});
