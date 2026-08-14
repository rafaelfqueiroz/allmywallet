import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, UserId, WalletId } from '@/core/shared/ids';
import { Quantity, sumQuantity } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import { WalletErrorCode, walletError } from '@/core/wallets/errors';
import type { WalletAllocation } from '@/core/wallets/ports';

/**
 * SPEC-010 — assignment, the feature's first design rule (DL-010-01):
 * "assignment defaults to the whole position and stays that way by itself."
 *
 * BR-010-03: one click takes the **entire held quantity** — no number typed.
 * BR-010-04: allocation is nonetheless stored **by quantity**, precisely so a
 * position can later be split deliberately (100 ITSA4 as 60/40) — splitting
 * is always a second, explicit action with its own quantity, never inferred.
 *
 * `quantity` here is the target **absolute** amount for this
 * `(wallet, asset)` pair, not a delta — assigning is "this wallet now holds
 * N of this asset", which is what makes correcting an earlier split (60/40 →
 * 70/30) the same one action as the first assignment. Omitting it is the
 * one-click default: **the full remaining unassigned quantity**, which for a
 * never-before-allocated asset equals the whole position (BR-010-03 read
 * literally) and for a partially-split one is "everything nobody has claimed
 * yet" — never invented by inferring from a wallet's *other* holdings.
 */
export interface AllocateToWalletInput {
  readonly walletId: WalletId;
  readonly assetId: AssetId;
  readonly quantity?: Quantity | undefined;
}

export async function allocateToWallet(
  deps: WalletDependencies,
  userId: UserId,
  input: AllocateToWalletInput,
): Promise<Result<WalletAllocation, DomainError>> {
  const wallet = await deps.wallets.findById(input.walletId);
  if (wallet === null || wallet.userId !== userId) {
    return err(walletError(WalletErrorCode.WALLET_NOT_FOUND, { walletId: input.walletId }));
  }

  const held = await deps.positionQuery.query(input.assetId);

  // BR-010-05: the sum invariant. Locking here — before reading or writing
  // any allocation for this asset — is what makes two concurrent assignments
  // against the same asset serialise instead of racing (ports.ts's note).
  const locked = await deps.allocations.lockForAsset(input.assetId);
  const others = locked.filter((allocation) => allocation.walletId !== input.walletId);
  const othersTotal = sumQuantity(others.map((allocation) => allocation.quantity));
  const existingForThisWallet = locked.find((allocation) => allocation.walletId === input.walletId);

  const quantity = input.quantity ?? held.quantity.minus(othersTotal);
  if (!quantity.isPositive()) {
    return err(
      walletError(WalletErrorCode.INVALID_ALLOCATION_QUANTITY, {
        assetId: input.assetId,
        quantity: quantity.toString(),
      }),
    );
  }

  const newTotal = othersTotal.plus(quantity);
  if (newTotal.comparedTo(held.quantity) > 0) {
    return err(
      walletError(WalletErrorCode.ALLOCATION_EXCEEDS_HOLDINGS, {
        assetId: input.assetId,
        held: held.quantity.toString(),
        requested: newTotal.toString(),
      }),
    );
  }

  const allocation: WalletAllocation = {
    userId,
    walletId: input.walletId,
    assetId: input.assetId,
    quantity,
    // BR-010-22: a fresh snapshot of the position's average cost at the
    // moment of (re-)assignment — an explicit assignment is a new decision,
    // unlike the auto-increment in apply-buy.ts, which accumulates instead.
    costBasisAtAllocation: held.averageCost.times(quantity),
    allocatedAt: existingForThisWallet?.allocatedAt ?? deps.clock.now(),
  };

  await deps.allocations.upsert(allocation);
  return ok(allocation);
}

/** One asset's holding that has not been claimed by any wallet (BR-010-06). */
export interface UnassignedHolding {
  readonly assetId: AssetId;
  readonly quantity: Quantity;
}

/**
 * BR-010-06/DL-010-07: Unassigned is **implicit and always visible** — held
 * minus allocated, computed here and never stored. Storing it would let it
 * drift from the ledger; computing it means wallet groups plus Unassigned
 * sum to the portfolio by construction, which is exactly what the
 * "Unassigned + wallets sum to the portfolio" integration test proves.
 *
 * Only positive remainders are returned — an asset fully allocated (or not
 * held at all) is not a queue item and should not render as a zero row.
 */
export async function computeUnassigned(
  deps: WalletDependencies,
  _userId: UserId,
): Promise<readonly UnassignedHolding[]> {
  const held = await deps.positionQuery.listHeld();
  const allocatedByAsset = await allocatedTotalsByAsset(deps);

  return held
    .map((position) => ({
      assetId: position.assetId,
      quantity: position.quantity.minus(allocatedByAsset.get(position.assetId) ?? Quantity.zero()),
    }))
    .filter((holding) => holding.quantity.isPositive());
}

/**
 * Shared by `computeUnassigned` above and `pending.ts`'s "Needs attention"
 * queue — both are the same held-minus-allocated merge, read for two
 * different purposes (BR-010-06's always-visible bucket vs BR-010-12's
 * queue), so the merge itself is written once.
 */
export async function allocatedTotalsByAsset(
  deps: WalletDependencies,
): Promise<Map<AssetId, Quantity>> {
  const allocations = await deps.allocations.listAll();
  const totals = new Map<AssetId, Quantity>();
  for (const allocation of allocations) {
    totals.set(
      allocation.assetId,
      (totals.get(allocation.assetId) ?? Quantity.zero()).plus(allocation.quantity),
    );
  }
  return totals;
}

/** How many distinct wallets currently hold a slice of this asset. */
export async function walletsHoldingCount(
  deps: WalletDependencies,
  assetId: AssetId,
): Promise<number> {
  const allocations = await deps.allocations.listForAsset(assetId);
  return new Set(allocations.map((allocation) => allocation.walletId)).size;
}
