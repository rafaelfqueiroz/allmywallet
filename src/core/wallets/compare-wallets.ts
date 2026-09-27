import type { UserId } from '@/core/shared/ids';
import { Money, type Quantity, sumMoney, sumQuantity } from '@/core/shared/money';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import type { Wallet } from '@/core/wallets/wallet';

/**
 * SPEC-010 BR-010-21 — wallets compared side by side. BR-010-19/20 (running
 * every report at wallet scope, wallet as a grouping dimension) belong to
 * SPEC-011, which is not built yet in this codebase — so this is the slice
 * available from wallets alone: composition by allocated quantity and cost
 * basis at allocation (BR-010-22). Performance (TWR/XIRR) needs SPEC-012's
 * valuation history and is out of this issue's reach.
 */
export interface WalletComparisonRow {
  readonly wallet: Wallet;
  readonly assetCount: number;
  readonly totalQuantity: Quantity;
  readonly totalCostBasis: Money;
  /**
   * SPEC-007 BR-007-06 (amended 2026-09-21) / DL-007-12 — any allocated
   * asset's *current* position carries an estimated cost. Read from
   * `PositionQueryPort`, never recomputed: a wallet's notion of "is this
   * estimated" cannot disagree with the Composition report's.
   */
  readonly costEstimated: boolean;
}

export async function compareWallets(
  deps: WalletDependencies,
  _userId: UserId,
): Promise<readonly WalletComparisonRow[]> {
  const wallets = await deps.wallets.list();

  // One read for every wallet, not one per allocation: the same held asset
  // is routinely split across several wallets, and re-querying its position
  // per wallet would be one round trip per row instead of one for the page.
  const held = await deps.positionQuery.listHeld();
  const costEstimatedByAsset = new Map(
    held.map((position) => [position.assetId, position.costEstimated]),
  );

  const rows: WalletComparisonRow[] = [];
  for (const wallet of wallets) {
    const allocations = await deps.allocations.listForWallet(wallet.id);
    rows.push({
      wallet,
      assetCount: allocations.length,
      totalQuantity: sumQuantity(allocations.map((allocation) => allocation.quantity)),
      totalCostBasis: sumMoney(
        allocations.map((allocation) => allocation.costBasisAtAllocation ?? Money.zero()),
      ),
      costEstimated: allocations.some(
        (allocation) => costEstimatedByAsset.get(allocation.assetId) ?? false,
      ),
    });
  }
  return rows;
}
