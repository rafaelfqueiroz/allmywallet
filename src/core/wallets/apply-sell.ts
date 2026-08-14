import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, UserId, WalletId } from '@/core/shared/ids';
import { Quantity, sumQuantity } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import { WalletErrorCode, walletError } from '@/core/wallets/errors';
import type { WalletAllocation } from '@/core/wallets/ports';

/**
 * SPEC-010 BR-010-17 / DL-010-05 — sells are **deliberately asymmetric**
 * with buys. A sale has already happened: the position shrank, so
 * allocations must come down or they violate BR-010-05. Unlike a buy
 * (`apply-buy.ts`), there is no "wait for a decision" option — the system
 * has no way to defer, so it reduces proportionally across every wallet
 * holding the asset, unless the caller names the wallet the sale came from.
 */
export interface ApplySellInput {
  readonly assetId: AssetId;
  readonly soldQuantity: Quantity;
  /** BR-010-17: "unless the user specifies which wallet sold." */
  readonly walletId?: WalletId | undefined;
}

export async function applySell(
  deps: WalletDependencies,
  userId: UserId,
  input: ApplySellInput,
): Promise<Result<readonly WalletAllocation[], DomainError>> {
  if (!input.soldQuantity.isPositive()) {
    return err(
      walletError(WalletErrorCode.INVALID_ALLOCATION_QUANTITY, {
        assetId: input.assetId,
        quantity: input.soldQuantity.toString(),
      }),
    );
  }

  const locked = await deps.allocations.lockForAsset(input.assetId);

  if (input.walletId !== undefined) {
    return applySpecifiedWalletSell(deps, userId, input.walletId, locked, input);
  }

  return applyProportionalSell(deps, userId, locked, input);
}

async function applySpecifiedWalletSell(
  deps: WalletDependencies,
  userId: UserId,
  walletId: WalletId,
  locked: readonly WalletAllocation[],
  input: ApplySellInput,
): Promise<Result<readonly WalletAllocation[], DomainError>> {
  const existing = locked.find((allocation) => allocation.walletId === walletId);
  if (existing === undefined || existing.quantity.comparedTo(input.soldQuantity) < 0) {
    return err(
      walletError(WalletErrorCode.WALLET_ALLOCATION_INSUFFICIENT, {
        walletId,
        assetId: input.assetId,
        allocated: (existing?.quantity ?? Quantity.zero()).toString(),
        requested: input.soldQuantity.toString(),
      }),
    );
  }

  const updated = reduceAllocation(existing, input.soldQuantity);
  await persist(deps, userId, updated);
  return ok([updated]);
}

/**
 * BR-010-17: each wallet's share of the reduction is proportional to its
 * share of the total allocated — `walletQty / allocatedTotal * reduction`.
 * Truncating that division per wallet (`money.ts`'s `ROUND_DOWN`) can leave a
 * residual fraction unreduced; the **last** wallet in a deterministic order
 * absorbs exactly that residual, so the sum of every reduction always equals
 * `reduction` precisely rather than drifting by an accumulating epsilon.
 *
 * Worked example (DV-17): 100 PETR4 split 60 Retirement / 40 Trading, a sale
 * of 10 with no wallet specified — reduction = min(10, 100) = 10:
 *   Retirement: 60 × 10 ÷ 100 = 6.00000000 → 54
 *   Trading (last, absorbs remainder): 10 − 6 = 4.00000000 → 36
 */
async function applyProportionalSell(
  deps: WalletDependencies,
  userId: UserId,
  locked: readonly WalletAllocation[],
  input: ApplySellInput,
): Promise<Result<readonly WalletAllocation[], DomainError>> {
  if (locked.length === 0) return ok([]);

  const allocatedTotal = sumQuantity(locked.map((allocation) => allocation.quantity));
  if (allocatedTotal.isZero()) return ok([]);

  // A sale can exceed what is allocated — the rest simply came out of
  // Unassigned, which needs no adjustment since it is never stored.
  const reduction =
    input.soldQuantity.comparedTo(allocatedTotal) > 0 ? allocatedTotal : input.soldQuantity;

  // Deterministic order so "the last one absorbs the remainder" is the same
  // wallet every time the same input is replayed.
  const sorted = [...locked].sort((a, b) => (a.walletId < b.walletId ? -1 : 1));

  const results: WalletAllocation[] = [];
  let reducedSoFar = Quantity.zero();
  for (const [index, allocation] of sorted.entries()) {
    const isLast = index === sorted.length - 1;
    const share = isLast
      ? reduction.minus(reducedSoFar)
      : allocation.quantity.times(reduction).dividedBy(allocatedTotal);
    reducedSoFar = reducedSoFar.plus(share);
    results.push(reduceAllocation(allocation, share));
  }

  for (const updated of results) {
    await persist(deps, userId, updated);
  }
  return ok(results);
}

function reduceAllocation(allocation: WalletAllocation, amount: Quantity): WalletAllocation {
  const newQuantity = allocation.quantity.minus(amount);
  return {
    ...allocation,
    quantity: newQuantity,
    // Proportional with the quantity, so the wallet's own average cost per
    // share is unchanged by a sale — the same shape as SPEC-007 BR-007-03,
    // which fixes the average and lets total cost move.
    costBasisAtAllocation:
      allocation.costBasisAtAllocation === null
        ? null
        : allocation.costBasisAtAllocation.times(newQuantity).dividedBy(allocation.quantity),
  };
}

async function persist(
  deps: WalletDependencies,
  userId: UserId,
  allocation: WalletAllocation,
): Promise<void> {
  if (allocation.quantity.isZero()) {
    await deps.allocations.delete(allocation.walletId, allocation.assetId);
    return;
  }
  await deps.allocations.upsert({ ...allocation, userId });
}
