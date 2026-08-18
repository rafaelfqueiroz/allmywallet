import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, UserId, WalletId } from '@/core/shared/ids';
import { type Result, err, ok } from '@/core/shared/result';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import type { StandingRule } from '@/core/wallets/ports';
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

/**
 * BR-010-14 / #61 — every rule this tenant has set, so they can be seen and
 * removed.
 *
 * **A rule with no read side is a permanent one.** `setStandingRule` and
 * `clearStandingRule` were both written; only the first had a caller, and
 * nothing could enumerate rules to render, so a standing instruction routing
 * every future purchase of an asset could be created and never revoked. For a
 * feature whose whole justification is that it is *opt-in* (DL-010-04), being
 * unable to opt back out is the defect.
 */
export async function listStandingRules(
  deps: WalletDependencies,
  _userId: UserId,
): Promise<readonly StandingRule[]> {
  return deps.assetRules.list();
}
