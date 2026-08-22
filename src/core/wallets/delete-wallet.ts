import type { DomainError } from '@/core/shared/domain-error';
import type { UserId, WalletId } from '@/core/shared/ids';
import { type Result, err, ok } from '@/core/shared/result';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import { WalletErrorCode, walletError } from '@/core/wallets/errors';

/**
 * SPEC-010 BR-010-07: deleting a wallet returns its allocations to
 * Unassigned and deletes no transactions. Because Unassigned is implicit —
 * held minus allocated, never stored (BR-010-06, DL-010-07) — "returning to
 * Unassigned" is exactly "the allocation rows stop existing"; nothing about
 * the ledger changes and no other wallet's rows are touched.
 *
 * Any standing rule pointing at this wallet is cleared too (BR-010-14): a
 * rule naming a wallet that no longer exists would otherwise silently
 * misdirect the next buy, or — depending on the adapter's foreign key
 * behaviour — block the delete outright.
 */
export async function deleteWallet(
  deps: WalletDependencies,
  userId: UserId,
  walletId: WalletId,
): Promise<Result<void, DomainError>> {
  const existing = await deps.wallets.findById(walletId);
  if (existing === null || existing.userId !== userId) {
    return err(walletError(WalletErrorCode.WALLET_NOT_FOUND, { walletId }));
  }

  // BR-010-07: the allocations disappear and the holdings return to
  // Unassigned. The *history* does not — SPEC-014 BR-014-12: this wallet did
  // hold those assets, and last year's income did not stop having been earned
  // because the wallet was tidied away today. The repository records a
  // zero-quantity event per asset rather than deleting the log.
  await deps.allocations.deleteForWallet(walletId, {
    effectiveOn: deps.clock.today(),
    cause: 'wallet_deleted',
  });
  await deps.assetRules.clearForWallet(walletId);
  await deps.wallets.delete(walletId);

  return ok(undefined);
}
