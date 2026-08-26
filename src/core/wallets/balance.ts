import type { UserId, WalletId } from '@/core/shared/ids';
import type { AssetId } from '@/core/shared/ids';
import { Quantity, sumMoney, type Money } from '@/core/shared/money';
import type { AssetClass } from '@/core/quotes/ports';
import {
  computeDrift,
  type DriftRow,
  type DriftUnavailableReason,
  type TargetedValue,
} from '@/core/wallets/drift';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import { rebalanceGap, type RebalanceGap } from '@/core/wallets/rebalance-gap';
import {
  TARGET_TOTAL_PCT,
  effectiveTargets,
  isTargetable,
  type TargetMode,
  type WalletTarget,
} from '@/core/wallets/targets';
import type { Wallet } from '@/core/wallets/wallet';

/**
 * SPEC-017 — the balance view, assembled.
 *
 * One pure function does the whole thing (`buildWalletBalance`), because the
 * three rules most likely to be got quietly wrong are all *the same*
 * arithmetic seen from different sides:
 *
 *  - BR-017-09/13: fixed income is excluded from the targeted universe **and**
 *    from the denominator every current share is computed against;
 *  - BR-017-10: the wallet must state what proportion of itself the targets
 *    actually cover, or a report over a subset reads as a report over the
 *    whole and understates exactly the concentration the feature exists to
 *    surface;
 *  - BR-017-18: the gap in R$ is a share of that same denominator.
 *
 * Split across three call sites, those drift apart the first time one of them
 * is changed. Here the denominator is computed once and everything else is a
 * fold over it.
 */

/** One asset a wallet holds, valued. The app boundary builds these from SPEC-011's holding set. */
export interface BalanceHolding {
  readonly assetId: AssetId;
  readonly assetClass: AssetClass;
  /** SPEC-010 BR-010-04: this wallet's own allocated quantity, not the whole position. */
  readonly quantity: Quantity;
  /** The market value of that allocated quantity (SPEC-011 BR-011-11). */
  readonly value: Money;
  /** BR-017-21 — see `drift.ts`'s `isPriceUsable`. */
  readonly priceUsable: boolean;
}

export interface BalanceRow extends DriftRow {
  readonly quantity: Quantity;
  /** BR-017-18: `null` while drift is unavailable — a gap needs a share to measure from. */
  readonly gap: RebalanceGap | null;
}

/** BR-017-10 — what the targets do *not* cover, itemised rather than implied. */
export interface UntargetedRow {
  readonly assetId: AssetId;
  readonly assetClass: AssetClass;
  readonly quantity: Quantity;
  readonly value: Money;
}

export interface WalletBalance {
  readonly walletId: WalletId;
  readonly walletName: string;
  readonly mode: TargetMode;
  readonly rows: readonly BalanceRow[];
  /** BR-017-09: the fixed income that never carries a target. */
  readonly untargeted: readonly UntargetedRow[];
  /** Everything the wallet holds, targeted or not. */
  readonly walletValue: Money;
  /** BR-017-13's denominator. */
  readonly targetedValue: Money;
  /**
   * BR-017-10 / AC-6 — "targets cover 60 % of this wallet". `null` when the
   * wallet is worth nothing, where a share of zero is undefined rather than
   * zero (the same refusal `sharesOf` makes in SPEC-015).
   */
  readonly targetedSharePct: Quantity | null;
  /** BR-017-16. Always false while drift is unavailable — see `computeDrift`. */
  readonly outOfBalance: boolean;
  /**
   * BR-017-07: a manual wallet is asking for a decision — either its targets
   * no longer total 100 %, or it holds something whose weight has never been
   * stated. `unsetAssetIds` says which.
   */
  readonly needsReview: boolean;
  readonly unsetAssetIds: readonly AssetId[];
  readonly unavailableReason: DriftUnavailableReason | null;
  readonly unpricedAssetIds: readonly AssetId[];
  /** BR-017-11: false → offer no target form, and say why. */
  readonly hasTargetableAssets: boolean;
  readonly tolerancePp: Quantity;
}

export interface BuildWalletBalanceInput {
  readonly wallet: Pick<Wallet, 'id' | 'name' | 'targetMode'>;
  /** The stored manual targets. Ignored in the other two modes (BR-017-05). */
  readonly stored: readonly WalletTarget[];
  readonly holdings: readonly BalanceHolding[];
  /** SPEC-002 `wallets.drift_tolerance_pp` — the user's number, never one this code chose. */
  readonly tolerancePp: Quantity;
}

export function buildWalletBalance(input: BuildWalletBalanceInput): WalletBalance {
  /*
   * Sorted by asset id, and this is load-bearing rather than cosmetic. Both
   * `equalWeightTargets` and `computeDrift` hand the residual to the **last**
   * element so their sets total exactly 100; an order that varied between
   * renders would move that residual between assets, and two loads of the same
   * unchanged wallet would disagree in the 40th significant digit.
   */
  const holdings = [...input.holdings].sort((a, b) => (a.assetId < b.assetId ? -1 : 1));

  // BR-017-09 / DL-017-04: the split that the rest of this function measures
  // everything against.
  const targetable = holdings.filter((holding) => isTargetable(holding.assetClass));
  const untargeted = holdings
    .filter((holding) => !isTargetable(holding.assetClass))
    .map((holding) => ({
      assetId: holding.assetId,
      assetClass: holding.assetClass,
      quantity: holding.quantity,
      value: holding.value,
    }));

  const { targets, needsReview, unsetAssetIds } = effectiveTargets(
    input.wallet.targetMode,
    input.stored,
    targetable.map((holding) => holding.assetId),
  );

  const values: readonly TargetedValue[] = targetable.map((holding) => ({
    assetId: holding.assetId,
    value: holding.value,
    priceUsable: holding.priceUsable,
  }));

  const drift = computeDrift(targets, values, input.tolerancePp);
  const byAsset = new Map(targetable.map((holding) => [holding.assetId, holding]));

  const rows: readonly BalanceRow[] = drift.rows.map((row) => {
    const holding = byAsset.get(row.assetId);
    const quantity = holding?.quantity ?? Quantity.zero();
    return {
      ...row,
      quantity,
      gap:
        row.currentPct === null
          ? null
          : rebalanceGap({
              assetId: row.assetId,
              targetPct: row.targetPct,
              currentPct: row.currentPct,
              value: row.value,
              quantity,
              targetedValue: drift.targetedValue,
            }),
    };
  });

  const walletValue = sumMoney(holdings.map((holding) => holding.value));

  return {
    walletId: input.wallet.id,
    walletName: input.wallet.name,
    mode: input.wallet.targetMode,
    rows,
    untargeted,
    walletValue,
    targetedValue: drift.targetedValue,
    targetedSharePct: walletValue.isZero()
      ? null
      : Quantity.fromString(drift.targetedValue.toString())
          .dividedBy(Quantity.fromString(walletValue.toString()))
          .times(TARGET_TOTAL_PCT),
    outOfBalance: drift.outOfBalance,
    needsReview,
    unsetAssetIds,
    unavailableReason: drift.unavailableReason,
    unpricedAssetIds: drift.unpricedAssetIds,
    hasTargetableAssets: targetable.length > 0,
    tolerancePp: input.tolerancePp,
  };
}

/**
 * BR-017-16/17 — every wallet's balance state in one pass.
 *
 * **One sweep rather than one query per wallet.** The "Needs attention" queue
 * on `/wallets` has to know whether *any* wallet is out of balance, and the
 * balance view for a single wallet needs the same computation for one of them.
 * The valuation behind `holdingsByWallet` is a single SPEC-011 report query at
 * portfolio scope, sliced by wallet at the boundary — asking per wallet would
 * re-price the whole portfolio once per wallet, and the figures could differ
 * between two of them if a quote landed in between.
 */
export interface ListWalletBalancesInput {
  /** Every wallet's valued holdings, keyed by wallet. A wallet with none is not omitted — it is empty. */
  readonly holdingsByWallet: ReadonlyMap<WalletId, readonly BalanceHolding[]>;
  readonly tolerancePp: Quantity;
}

export async function listWalletBalances(
  deps: WalletDependencies,
  _userId: UserId,
  input: ListWalletBalancesInput,
): Promise<readonly WalletBalance[]> {
  const [wallets, stored] = await Promise.all([deps.wallets.list(), deps.targets.listAll()]);

  const storedByWallet = new Map<WalletId, WalletTarget[]>();
  for (const target of stored) {
    const list = storedByWallet.get(target.walletId) ?? [];
    list.push({ assetId: target.assetId, targetPct: target.targetPct });
    storedByWallet.set(target.walletId, list);
  }

  return wallets.map((wallet) =>
    buildWalletBalance({
      wallet,
      stored: storedByWallet.get(wallet.id) ?? [],
      holdings: input.holdingsByWallet.get(wallet.id) ?? [],
      tolerancePp: input.tolerancePp,
    }),
  );
}

/**
 * BR-017-17 / DL-017-08 — the wallets that belong in the **existing** "Needs
 * attention" queue (SPEC-010 BR-010-12). No second surface: a second place to
 * look makes "is there anything for me to do?" a two-place question.
 *
 * A wallet needing review (BR-017-07) belongs there too. Its targets no longer
 * total 100 %, which is a decision waiting on the user in exactly the sense the
 * queue exists for — and unlike an out-of-tolerance drift, it is a state only
 * they can resolve.
 */
export function walletsNeedingAttention(
  balances: readonly WalletBalance[],
): readonly WalletBalance[] {
  return balances.filter((balance) => balance.outOfBalance || balance.needsReview);
}
