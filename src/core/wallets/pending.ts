import type { UserId } from '@/core/shared/ids';
import { Quantity } from '@/core/shared/money';
import { allocatedTotalsByAsset } from '@/core/wallets/allocate';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import type { AssetPositionQuery } from '@/core/wallets/ports';

/**
 * SPEC-010 BR-010-12 — "purchases awaiting allocation appear in the same
 * 'Needs attention' queue used for unclassified imports, and on the
 * post-import summary and dashboard, until resolved."
 *
 * There is no separate `pending_allocations` table (the data model in the
 * issue names only `wallets`, `wallet_allocations` and `wallet_asset_rules`)
 * — a pending item is not new state, it is the **same** held-minus-allocated
 * fact `allocate.ts`'s `computeUnassigned` already computes, read through a
 * lens that explains *why* an asset is sitting there for the "Needs
 * attention" UI: nobody has ever allocated it (`no_wallet` — BR-010-16's
 * brand-new holding, or an existing one nobody got around to), or it is
 * deliberately split and a buy landed with nowhere unambiguous to go
 * (`ambiguous_split` — BR-010-11). BR-010-13's "resolve in one action with
 * quantity pre-filled" is `allocateToWallet` called with this item's
 * `unassignedQuantity` and **`mode: 'add'`** — the remainder is a delta to
 * add to whatever the chosen wallet already holds, never that wallet's new
 * absolute total. An `ambiguous_split` item is by definition an asset already
 * held in at least one wallet, so the absolute reading destroyed data on
 * precisely this queue's primary flow.
 */
export interface PendingAllocation {
  readonly assetId: AssetPositionQuery['assetId'];
  readonly unassignedQuantity: AssetPositionQuery['quantity'];
  readonly reason: 'no_wallet' | 'ambiguous_split';
}

export async function listPendingAllocations(
  deps: WalletDependencies,
  _userId: UserId,
): Promise<readonly PendingAllocation[]> {
  const held = await deps.positionQuery.listHeld();
  const allocatedTotals = await allocatedTotalsByAsset(deps);

  const pending: PendingAllocation[] = [];
  for (const position of held) {
    const allocated = allocatedTotals.get(position.assetId) ?? Quantity.zero();
    const unassignedQuantity = position.quantity.minus(allocated);
    if (!unassignedQuantity.isPositive()) continue;

    const walletCount = await walletCountFor(deps, position.assetId);
    pending.push({
      assetId: position.assetId,
      unassignedQuantity,
      reason: walletCount === 0 ? 'no_wallet' : 'ambiguous_split',
    });
  }
  return pending;
}

async function walletCountFor(
  deps: WalletDependencies,
  assetId: AssetPositionQuery['assetId'],
): Promise<number> {
  const allocations = await deps.allocations.listForAsset(assetId);
  return new Set(allocations.map((allocation) => allocation.walletId)).size;
}
