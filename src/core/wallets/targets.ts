import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, UserId, WalletId } from '@/core/shared/ids';
import { Quantity, sumQuantity } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import type { AssetClass } from '@/core/quotes/ports';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import { WalletErrorCode, walletError } from '@/core/wallets/errors';
import type { StoredWalletTarget } from '@/core/wallets/ports';
import type { Wallet } from '@/core/wallets/wallet';

/**
 * SPEC-017 — the targets half: what proportions the user said they intended.
 *
 * ---------------------------------------------------------------------------
 * EVERY NUMBER IN THIS FILE ORIGINATES WITH THE USER.
 *
 * That is not a stylistic preference, it is the condition SPEC-017 exists
 * under. DL-015-03 rejected target allocation outright because rebalancing
 * advice would make the product an unlicensed advisor (PRD risk R7);
 * DL-017-01 reverses that exclusion on exactly one ground — the product
 * stores a percentage that was typed in, or divides by the number of assets
 * the user themselves put in the wallet, and never originates a threshold,
 * ranks an asset or names a trade.
 *
 * So nothing here proposes a target. `equalWeightTargets` is `100 / n` over a
 * set the user chose; `validateManualTargets` refuses a set rather than
 * repairing it into one the product invented. A function here that "suggested"
 * anything would take the whole feature outside the ground it stands on.
 * ---------------------------------------------------------------------------
 */

/** BR-017-02. Mirrored as a CHECK on `wallets.target_mode` in `src/db/schema/wallets.ts`. */
export const TARGET_MODES = ['none', 'equal_weight', 'manual'] as const;
export type TargetMode = (typeof TARGET_MODES)[number];

export function isTargetMode(value: string): value is TargetMode {
  return (TARGET_MODES as readonly string[]).includes(value);
}

/** BR-017-04 — the total every target set must hit, exactly. */
export const TARGET_TOTAL_PCT = Quantity.fromString('100');

/**
 * BR-017-09 / DL-017-04 — the classes a target may cover.
 *
 * Fixed income is excluded, and the reason is liquidity rather than taxonomy:
 * a CDB before maturity typically cannot be sold at all, so its drift is
 * uncorrectable and the wallet would sit permanently out of balance over
 * something the user cannot act on — which trains them to ignore the flag that
 * matters. Tesouro Direto is excluded with the bank paper: it *is* saleable,
 * but at a marked-to-market price whose movement is the indexer's, not a
 * decision anybody made about weight.
 *
 * Deliberately the complement of `core/valuation/holdings.ts`'s
 * `FIXED_INCOME_CLASSES` **plus** `tesouro_direto`, written out rather than
 * derived so that adding a ninth asset class fails a test here rather than
 * silently deciding it is targetable.
 */
export const TARGETABLE_CLASSES: ReadonlySet<AssetClass> = new Set<AssetClass>([
  'stock',
  'fii',
  'bdr',
  'etf',
]);

export function isTargetable(assetClass: AssetClass): boolean {
  return TARGETABLE_CLASSES.has(assetClass);
}

/** BR-017-03: a percentage of market value, for one asset. */
export interface WalletTarget {
  readonly assetId: AssetId;
  readonly targetPct: Quantity;
}

export function sumTargetPct(targets: readonly WalletTarget[]): Quantity {
  return sumQuantity(targets.map((target) => target.targetPct));
}

/**
 * BR-017-05 — equal weight, derived rather than stored.
 *
 * **The last share takes the residual**, exactly as
 * `core/reporting/base-query.ts`'s `distributeExact` does and for the same
 * reason. `100 ÷ 3` does not terminate; `Quantity.dividedBy` truncates at 40
 * significant digits, so three computed thirds sum to 99,999…, and a target
 * set that does not total 100 is one BR-017-04 would reject — a wallet whose
 * own equal-weight mode produced an invalid set. Giving the last element
 * `100 − Σ(others)` makes the total exact by construction rather than by luck.
 *
 * The asymmetry is invisible: the residual differs from its siblings by at
 * most (n−1) units in the 40th significant digit, thirty orders of magnitude
 * below anything displayed or stored.
 */
export function equalWeightTargets(assetIds: readonly AssetId[]): readonly WalletTarget[] {
  if (assetIds.length === 0) return [];

  // `String(length)` rather than `Quantity.unsafeFromNumber` — a count is an
  // integer that already round-trips exactly through a decimal literal, and
  // `unsafeFromNumber` is reserved for hand-written test and seed values.
  const share = TARGET_TOTAL_PCT.dividedBy(Quantity.fromString(String(assetIds.length)));

  const targets: WalletTarget[] = [];
  let allocated = Quantity.zero();
  for (let index = 0; index < assetIds.length - 1; index += 1) {
    targets.push({ assetId: assetIds[index] as AssetId, targetPct: share });
    allocated = allocated.plus(share);
  }
  targets.push({
    assetId: assetIds[assetIds.length - 1] as AssetId,
    targetPct: TARGET_TOTAL_PCT.minus(allocated),
  });
  return targets;
}

/**
 * BR-017-04 / AC-4 — a manual set that does not total exactly 100 % is
 * **rejected at write time**, with the shortfall or excess named.
 *
 * DL-017-03 ruled out accepting under-100 as deliberate headroom: it would
 * create two distinct balanced states, both needing expression in the UI, and
 * a second denominator for every drift figure. A user planning a purchase
 * expresses that with a 0 % row instead.
 *
 * `difference` in the error context is `100 − total`: positive is a shortfall,
 * negative an excess. One signed number rather than two codes, because the
 * i18n layer renders both from the sign (AR-38) and a caller that wants to
 * know which asked the sign.
 */
export function validateManualTargets(
  targets: readonly WalletTarget[],
): Result<readonly WalletTarget[], DomainError<WalletErrorCode>> {
  const seen = new Set<AssetId>();
  for (const target of targets) {
    if (seen.has(target.assetId)) {
      return err(walletError(WalletErrorCode.DUPLICATE_TARGET_ASSET, { assetId: target.assetId }));
    }
    seen.add(target.assetId);

    if (target.targetPct.isNegative() || target.targetPct.comparedTo(TARGET_TOTAL_PCT) > 0) {
      return err(
        walletError(WalletErrorCode.INVALID_TARGET_PCT, {
          assetId: target.assetId,
          targetPct: target.targetPct.toString(),
        }),
      );
    }
  }

  const total = sumTargetPct(targets);
  if (!total.equals(TARGET_TOTAL_PCT)) {
    return err(
      walletError(WalletErrorCode.TARGETS_MUST_TOTAL_100, {
        total: total.toString(),
        difference: TARGET_TOTAL_PCT.minus(total).toString(),
      }),
    );
  }
  return ok(targets);
}

/**
 * BR-017-07 / BR-017-24 — the manual set, reconciled against the assets the
 * wallet actually holds today.
 *
 * **Nothing is rescaled.** An asset joining enters at 0 % and every hand-set
 * percentage is left exactly as typed, which is deliberately asymmetric with
 * equal weight (BR-017-06) and is DL-017-05's whole point: "keep these equal"
 * is a standing instruction the product may act on, while a hand-set 15/10
 * split is specific intent, and silently rescaling it is precisely the
 * inference SPEC-010 BR-010-11 refuses to make.
 *
 * An asset that has left the wallet drops out of the effective set — but its
 * stored row is **not deleted** here. This function is pure and is called on
 * every read; deleting the user's stated intent because a holding briefly went
 * to Unassigned would destroy data on a read path. The row is inert while the
 * asset is absent and returns as typed if the asset does.
 *
 * `needsReview` is BR-017-07's flag: the effective set no longer totals 100 %,
 * so the wallet is asking for a decision rather than being wrong.
 */
export interface ReconciledTargets {
  readonly targets: readonly WalletTarget[];
  /**
   * BR-017-07's flag. **Two conditions, not one**, and the second is the one
   * the rule's own wording nearly hides.
   *
   * "The wallet is flagged as needing review until targets total 100 % again"
   * would, read alone, clear the flag the instant the asset entered — 60 + 40
   * + 0 is already 100, so an entrant at zero would never raise it and the
   * first half of the rule would mean nothing. AC-3 is explicit that adding an
   * asset to a manual wallet *does* flag it, so the flag has to fire on the
   * entrant itself: a holding whose weight the user has never stated is an
   * open question regardless of what the other rows add up to.
   *
   * A target the user deliberately set to 0 % is not an open question. It has
   * a stored row, so it is not an entrant, and it does not flag — which is
   * also what makes DL-017-03's "a 0 % row already covers planning a future
   * purchase" usable rather than a permanent warning.
   */
  readonly needsReview: boolean;
  /** The targetable holdings with no stored percentage — BR-017-07's entrants. */
  readonly unsetAssetIds: readonly AssetId[];
}

export function reconcileManualTargets(
  stored: readonly WalletTarget[],
  targetableAssetIds: readonly AssetId[],
): ReconciledTargets {
  const byAsset = new Map(stored.map((target) => [target.assetId, target.targetPct]));
  const targets = targetableAssetIds.map((assetId) => ({
    assetId,
    targetPct: byAsset.get(assetId) ?? Quantity.zero(),
  }));
  const unsetAssetIds = targetableAssetIds.filter((assetId) => !byAsset.has(assetId));

  return {
    targets,
    needsReview: unsetAssetIds.length > 0 || !sumTargetPct(targets).equals(TARGET_TOTAL_PCT),
    unsetAssetIds,
  };
}

/**
 * The effective target set for a wallet, in the mode it is in.
 *
 * **Derived on every read, never synchronised by a write hook**, which is what
 * makes BR-017-06's "an asset joining or leaving recomputes every target
 * automatically" free rather than a listener on four allocation write paths
 * that each have to remember to fire it. It is also why BR-017-23 needs no
 * code at all: a split scales the allocation and the position by the same
 * ratio (BR-010-18), the asset set is unchanged, and a set of percentages
 * recomputed from an unchanged set of assets is the same set of percentages.
 * And it is why AC-16 holds — a position rebuild (DM-4) rewrites `positions`,
 * touches no target row, and the next read derives the same answer.
 */
export function effectiveTargets(
  mode: TargetMode,
  stored: readonly WalletTarget[],
  targetableAssetIds: readonly AssetId[],
): ReconciledTargets {
  switch (mode) {
    case 'none':
      return { targets: [], needsReview: false, unsetAssetIds: [] };
    case 'equal_weight':
      // BR-017-05/06. Nothing stored, so nothing can be stale and nothing is
      // ever an unanswered question — that asymmetry with manual mode *is*
      // DL-017-05.
      return {
        targets: equalWeightTargets(targetableAssetIds),
        needsReview: false,
        unsetAssetIds: [],
      };
    case 'manual':
      return reconcileManualTargets(stored, targetableAssetIds);
  }
}

// ---------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------

/**
 * One wallet's intentions after a write, with the market value deliberately
 * absent — that arrives from SPEC-009/SPEC-011 and is combined in
 * `core/wallets/balance.ts`, which is also where every *read* path gets its
 * target set from. There is deliberately no `loadWalletTargets` beside this:
 * a second way to read the same derivation is a second thing to keep in
 * agreement with `effectiveTargets`, and the balance view already needs the
 * valuation this one would not have.
 */
export interface WalletTargetState {
  readonly wallet: Wallet;
  readonly mode: TargetMode;
  /** BR-017-09: the wallet's holdings that may carry a target, in a stable order. */
  readonly targetableAssetIds: readonly AssetId[];
  /** Every asset the wallet holds that never carries one — stated, not hidden (BR-017-10). */
  readonly untargetableAssetIds: readonly AssetId[];
  readonly stored: readonly WalletTarget[];
  readonly targets: readonly WalletTarget[];
  readonly needsReview: boolean;
}

/**
 * BR-017-02/04/08 — set a wallet's target mode, and in manual mode its
 * percentages.
 *
 * **The whole write runs under `lockForWallet`.** BR-017-04's "exactly 100 %"
 * spans rows, so no CHECK constraint can hold it (see `src/db/schema/
 * wallets.ts`); two concurrent edits that each individually total 100 would
 * otherwise interleave into a stored set that does not. The lock is taken on
 * the wallet row itself rather than on the target rows, which closes the
 * phantom gap a wallet with no targets yet would leave — there would be
 * nothing to lock.
 */
export interface SetWalletTargetsInput {
  readonly walletId: WalletId;
  readonly mode: TargetMode;
  /** Required in `manual` mode, ignored otherwise. */
  readonly targets?: readonly WalletTarget[] | undefined;
  /**
   * BR-017-08 / AC-5 — leaving manual mode discards hand-set targets, so the
   * caller must have shown the user what will be lost and carried their answer
   * back. A default of `false` means a caller that has not thought about it
   * gets the refusal rather than the deletion.
   */
  readonly confirmDiscard?: boolean | undefined;
}

export async function setWalletTargets(
  deps: WalletDependencies,
  userId: UserId,
  input: SetWalletTargetsInput,
): Promise<Result<WalletTargetState, DomainError<WalletErrorCode>>> {
  const wallet = await deps.wallets.findById(input.walletId);
  if (wallet === null || wallet.userId !== userId) {
    return err(walletError(WalletErrorCode.WALLET_NOT_FOUND, { walletId: input.walletId }));
  }

  const partition = await partitionWalletAssets(deps, input.walletId);

  // BR-017-11: an empty form would invite the user to fill in a set that
  // cannot exist. The refusal names the condition so the UI can explain it.
  if (input.mode !== 'none' && partition.targetable.length === 0) {
    return err(
      walletError(WalletErrorCode.WALLET_HAS_NO_TARGETABLE_ASSETS, { walletId: input.walletId }),
    );
  }

  const locked = toDomainTargets(await deps.targets.lockForWallet(input.walletId));

  // BR-017-08: manual → anything else destroys percentages that were typed in.
  // Nothing else in this use case deletes user-authored data, so this is the
  // one place a confirmation is owed.
  if (wallet.targetMode === 'manual' && input.mode !== 'manual' && locked.length > 0) {
    if (input.confirmDiscard !== true) {
      return err(
        walletError(WalletErrorCode.TARGET_DISCARD_NOT_CONFIRMED, {
          walletId: input.walletId,
          discardedCount: locked.length,
        }),
      );
    }
  }

  let toStore: readonly WalletTarget[] = [];
  if (input.mode === 'manual') {
    const supplied = input.targets ?? [];

    // BR-017-09/12: a target may only name an asset this wallet actually holds
    // and that may carry one. An unassigned holding is in no wallet, so it
    // cannot reach this list at all.
    const allowed = new Set(partition.targetable);
    for (const target of supplied) {
      if (!allowed.has(target.assetId)) {
        return err(
          walletError(WalletErrorCode.TARGET_ASSET_NOT_TARGETABLE, {
            walletId: input.walletId,
            assetId: target.assetId,
          }),
        );
      }
    }

    // Every targetable asset must be named, or the set could total 100 % while
    // silently leaving a holding out of the denominator it is measured against.
    // A 0 % row is how "I hold this and intend nothing of it" is expressed.
    const named = new Set(supplied.map((target) => target.assetId));
    const missing = partition.targetable.filter((assetId) => !named.has(assetId));
    if (missing.length > 0) {
      return err(
        walletError(WalletErrorCode.TARGET_ASSET_MISSING, {
          walletId: input.walletId,
          assetId: missing[0] as string,
          missingCount: missing.length,
        }),
      );
    }

    const validated = validateManualTargets(supplied);
    if (!validated.ok) return validated;
    toStore = validated.value;
  }

  await deps.targets.replaceForWallet(
    input.walletId,
    toStore.map((target) => ({
      walletId: input.walletId,
      assetId: target.assetId,
      targetPct: target.targetPct,
    })),
  );
  await deps.wallets.update({
    ...wallet,
    targetMode: input.mode,
    updatedAt: deps.clock.now(),
  });

  const { targets, needsReview } = effectiveTargets(input.mode, toStore, partition.targetable);
  return ok({
    wallet: { ...wallet, targetMode: input.mode },
    mode: input.mode,
    targetableAssetIds: partition.targetable,
    untargetableAssetIds: partition.untargetable,
    stored: toStore,
    targets,
    needsReview,
  });
}

// ---------------------------------------------------------------------------

export interface WalletAssetPartition {
  readonly targetable: readonly AssetId[];
  readonly untargetable: readonly AssetId[];
}

/**
 * The wallet's own assets, split by whether they may carry a target
 * (BR-017-09), each half sorted so every derived figure — an equal-weight
 * share, the residual, the order of the rows on screen — is reproducible.
 *
 * BR-017-12: this reads `wallet_allocations`, so the Unassigned remainder is
 * structurally absent. It is in no wallet; there is nothing to exclude.
 */
async function partitionWalletAssets(
  deps: WalletDependencies,
  walletId: WalletId,
): Promise<WalletAssetPartition> {
  const allocations = await deps.allocations.listForWallet(walletId);
  const assetIds = [...new Set(allocations.map((allocation) => allocation.assetId))].sort();
  if (assetIds.length === 0) return { targetable: [], untargetable: [] };

  const catalog = await deps.assetCatalog.findByIds(assetIds);
  const classes = new Map(catalog.map((asset) => [asset.id, asset.assetClass]));

  const targetable: AssetId[] = [];
  const untargetable: AssetId[] = [];
  for (const assetId of assetIds) {
    const assetClass = classes.get(assetId);
    // An asset the catalog does not know cannot be classified, and guessing
    // "targetable" would put it into the 100 % denominator on a guess. It is
    // treated as untargetable, which understates nothing: BR-017-10 states the
    // targeted share explicitly, so the wallet reports less coverage rather
    // than a wrong split.
    if (assetClass !== undefined && isTargetable(assetClass)) targetable.push(assetId);
    else untargetable.push(assetId);
  }
  return { targetable, untargetable };
}

export function toDomainTargets(stored: readonly StoredWalletTarget[]): readonly WalletTarget[] {
  return stored.map((row) => ({ assetId: row.assetId, targetPct: row.targetPct }));
}
