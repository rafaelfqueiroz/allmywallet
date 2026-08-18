import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, UserId } from '@/core/shared/ids';
import { sumQuantity } from '@/core/shared/money';
import { type Result, ok } from '@/core/shared/result';
import { applySell } from '@/core/wallets/apply-sell';
import type { WalletDependencies } from '@/core/wallets/dependencies';

/**
 * SPEC-010 BR-010-05, for the two ledger operations that shrink a position
 * **without a sale row to apply**: SPEC-006's edit (BR-006-12) and delete
 * (BR-006-13).
 *
 * ---------------------------------------------------------------------------
 * WHY `applyLedgerEffects` IS NOT ENOUGH
 *
 * That module is a fold over transactions that *arrived*. Every reduction it
 * knows about is a row — a sell, a transfer out, a negative adjustment. A
 * deletion is the absence of a row, and an edit from 100 to 60 is a row
 * changing underneath the position; neither produces anything to fold.
 *
 * So deleting a buy of a fully-allocated asset shrinks the position and leaves
 * the allocations exactly where they were — `sum(allocations) > held`, the
 * invariant broken, with nothing that would ever repair it. That is the same
 * failure BR-010-17 had before `apply-ledger-effects.ts` existed: the position
 * moved and the allocations did not.
 *
 * **Refusing instead was considered and rejected.** An `assertWithinHoldings`
 * that fails the write would make an allocated transaction undeletable, which
 * DL-006-04 explicitly refuses ("forbidding deletion pushes users to
 * workarounds that corrupt the ledger worse"). The excess is therefore reduced
 * the way every other reduction is reduced — proportionally across the wallets
 * holding the asset, `applySell`'s BR-010-17 rule, reused rather than restated
 * so the two cannot disagree about rounding residuals.
 *
 * Run **after** the position has been recalculated and inside the same tenant
 * transaction as the ledger write (AR-11): it compares against the position
 * cache, so on stale figures it would reduce by the wrong amount.
 * ---------------------------------------------------------------------------
 */
export interface AllocationReduction {
  readonly assetId: AssetId;
  /** How much had to come out of wallets to fit inside the new holding. */
  readonly excess: string;
}

export async function reconcileAllocationsToHoldings(
  deps: WalletDependencies,
  userId: UserId,
  assetIds: Iterable<AssetId>,
): Promise<Result<readonly AllocationReduction[], DomainError>> {
  const reductions: AllocationReduction[] = [];

  for (const assetId of assetIds) {
    // Locked, not the plain read `assertWithinHoldings` uses: this one writes
    // on the strength of what it read (ports.ts's note on the sum invariant).
    const locked = await deps.allocations.lockForAsset(assetId);
    if (locked.length === 0) continue;

    const allocated = sumQuantity(locked.map((allocation) => allocation.quantity));
    const held = await deps.positionQuery.query(assetId);
    const excess = allocated.minus(held.quantity);
    if (!excess.isPositive()) continue;

    const result = await applySell(deps, userId, { assetId, soldQuantity: excess });
    if (!result.ok) return result;
    reductions.push({ assetId, excess: excess.toString() });
  }

  return ok(reductions);
}
