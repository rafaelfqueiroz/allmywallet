import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, UserId, WalletId } from '@/core/shared/ids';
import { type Result, err, ok } from '@/core/shared/result';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import { WalletErrorCode, walletError } from '@/core/wallets/errors';

/**
 * SPEC-010 BR-010-14 / DL-010-04 — the escape hatch from BR-010-11: **opt-in,
 * off by default**. Setting one is the user's explicit instruction, which is
 * why `apply-buy.ts` checks it before ever considering "how many wallets
 * hold this asset" — a rule is not an inference, so BR-010-11's "never
 * guess" does not apply once one exists.
 */
export async function setStandingRule(
  deps: WalletDependencies,
  userId: UserId,
  assetId: AssetId,
  walletId: WalletId,
): Promise<Result<void, DomainError>> {
  const wallet = await deps.wallets.findById(walletId);
  if (wallet === null || wallet.userId !== userId) {
    return err(walletError(WalletErrorCode.WALLET_NOT_FOUND, { walletId }));
  }

  await deps.assetRules.set(assetId, walletId);
  return ok(undefined);
}

/** Reverts an asset to BR-010-11's default (off) — future buys are ambiguous again if split. */
export async function clearStandingRule(
  deps: WalletDependencies,
  _userId: UserId,
  assetId: AssetId,
): Promise<Result<void, DomainError>> {
  await deps.assetRules.clear(assetId);
  return ok(undefined);
}
