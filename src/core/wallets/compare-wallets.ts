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
}

export async function compareWallets(
  deps: WalletDependencies,
  _userId: UserId,
): Promise<readonly WalletComparisonRow[]> {
  const wallets = await deps.wallets.list();

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
    });
  }
  return rows;
}
