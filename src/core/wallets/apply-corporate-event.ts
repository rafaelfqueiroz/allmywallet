import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, UserId } from '@/core/shared/ids';
import type { Quantity } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import { WalletErrorCode, walletError } from '@/core/wallets/errors';
import type { WalletAllocation } from '@/core/wallets/ports';

/**
 * SPEC-010 BR-010-18 / DL-010-08 — a split, grupamento or bonificação scales
 * every wallet's allocated quantity by the same ratio as the position,
 * preserving each wallet's proportional share. It is a mechanical
 * adjustment, not new intent (unlike a buy), so it is applied **without
 * asking** — routing it to "Needs attention" like a purchase would be noise,
 * because the user's economic position and its purpose have not changed,
 * only the share count moved.
 *
 * `ratio` is supplied by the caller uniformly for all three event types,
 * mirroring SPEC-007 BR-007-04's handling of split/grupamento (the ratio is
 * the transaction's own `ratio` field) and BR-007-05's bonificação (which
 * carries an absolute bonus quantity, not a ratio) — for a bonificação the
 * caller derives an equivalent ratio as `(oldPositionQuantity +
 * bonusQuantity) / oldPositionQuantity` before calling this function, so the
 * wallet engine has exactly one code path for "scale by ratio" rather than
 * two.
 *
 * Cost basis is left **untouched**, the same shape as SPEC-007's positions:
 * BR-007-04 fixes total cost on a split and lets the average move, and this
 * mirrors that for a wallet's own `costBasisAtAllocation` — no money changed
 * hands, only how many pieces it is divided into.
 *
 * Worked example (DV-17): a wallet holding 60 ITSA4 at a cost basis of
 * R$ 600,00 after a 1:2 split (ratio 2) becomes 120 ITSA4, cost basis still
 * R$ 600,00 — exactly SPEC-007's "total cost unchanged, average halves",
 * applied to the wallet's own slice instead of the whole position.
 */
export async function applyCorporateEventToAllocations(
  deps: WalletDependencies,
  userId: UserId,
  assetId: AssetId,
  ratio: Quantity,
): Promise<Result<readonly WalletAllocation[], DomainError>> {
  if (!ratio.isPositive()) {
    return err(walletError(WalletErrorCode.INVALID_RATIO, { assetId, ratio: ratio.toString() }));
  }

  // BR-010-05: locked for the same reason every other write path locks first
  // (ports.ts) — even though scaling every row by the same ratio cannot by
  // itself push the sum over the position's own (identically-scaled) total,
  // a concurrent allocation racing this event must not interleave with it.
  const locked = await deps.allocations.lockForAsset(assetId);
  if (locked.length === 0) return ok([]);

  const updated: WalletAllocation[] = [];
  for (const allocation of locked) {
    const scaled: WalletAllocation = {
      ...allocation,
      userId,
      quantity: allocation.quantity.times(ratio),
    };
    await deps.allocations.upsert(scaled);
    updated.push(scaled);
  }
  return ok(updated);
}
