import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, UserId, WalletId } from '@/core/shared/ids';
import { Money, Quantity, sumQuantity } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import { WalletErrorCode, walletError } from '@/core/wallets/errors';
import type { WalletAllocation } from '@/core/wallets/ports';

/**
 * SPEC-010 — the feature's second design rule (DL-010-02/DL-010-03):
 * "where the answer is ambiguous, the system stops rather than guesses."
 *
 * BR-010-10: a purchase of an asset allocated to **exactly one** wallet adds
 * the full purchased quantity there, with no user action.
 * BR-010-11: a purchase of an asset split across **more than one** wallet is
 * never auto-allocated — proportional distribution would invent an intention
 * the user never expressed (DL-010-03's worked example: is more ITSA4 for
 * retirement or for the trade? the existing split is evidence of nothing).
 * BR-010-16: a brand-new asset (zero wallets) is never guessed into one either.
 * BR-010-14: an opt-in standing rule is the user's own instruction, not an
 * inference, and overrides BR-010-11 for that asset — checked first, below.
 */
export interface ApplyBuyInput {
  readonly assetId: AssetId;
  readonly purchasedQuantity: Quantity;
  /**
   * Where the BR-010-05 sum invariant is enforced for this call.
   *
   * `'now'` (the default) compares against the position as it stands, which
   * is right for a standalone assignment: nothing else is in flight.
   *
   * `'deferred'` is for a chronological replay of a whole committed batch
   * (`apply-ledger-effects.ts`). The position cache there already reflects
   * **every** transaction in the batch, so checking mid-replay compares an
   * intermediate allocation against a final position. A round trip — buy 50
   * on the 2nd, sell 50 on the 20th — reads as a 150-share over-allocation at
   * the buy even though the batch ends perfectly valid, and because the
   * failure is deterministic the commit can never succeed on retry. The
   * invariant is not weakened, only moved: the replay checks it once, at the
   * end, against the same position — see `assertWithinHoldings` there.
   */
  readonly heldCheck?: 'now' | 'deferred' | undefined;
  /**
   * SPEC-014 BR-014-12 — the **trade date** of the buy that caused this
   * allocation, not today. An import of four years of extracts runs this
   * hundreds of times in an afternoon; dating those events by the clock would
   * tell the earnings report that every one of those wallets was empty when
   * its proventos were paid.
   */
  readonly effectiveOn: BusinessDate;
}

export type BuyAllocationOutcome =
  | {
      readonly kind: 'standing_rule';
      readonly walletId: WalletId;
      readonly allocation: WalletAllocation;
    }
  | {
      readonly kind: 'auto_incremented';
      readonly walletId: WalletId;
      readonly allocation: WalletAllocation;
    }
  /**
   * BR-010-12: nothing was allocated — the purchased quantity sits in the
   * implicit Unassigned bucket and belongs in the "Needs attention" queue
   * until the user resolves it (`pending.ts`). `reason` is not a spec-defined
   * code, only a UI hint distinguishing "nobody has ever held this" from "it
   * is deliberately split" — both produce the identical no-allocation effect.
   */
  | { readonly kind: 'pending'; readonly reason: 'no_wallet' | 'ambiguous_split' };

export async function applyBuy(
  deps: WalletDependencies,
  userId: UserId,
  input: ApplyBuyInput,
): Promise<Result<BuyAllocationOutcome, DomainError>> {
  if (!input.purchasedQuantity.isPositive()) {
    return err(
      walletError(WalletErrorCode.INVALID_ALLOCATION_QUANTITY, {
        assetId: input.assetId,
        quantity: input.purchasedQuantity.toString(),
      }),
    );
  }

  // BR-010-05: locked before any decision that leads to a write, for the
  // same reason `allocate.ts` locks first — see `ports.ts`'s invariant note.
  const locked = await deps.allocations.lockForAsset(input.assetId);
  const held = await deps.positionQuery.query(input.assetId);

  const standingRuleWalletId = await deps.assetRules.find(input.assetId);
  if (standingRuleWalletId !== null) {
    return incrementWallet(
      deps,
      userId,
      'standing_rule',
      standingRuleWalletId,
      locked,
      held.averageCost,
      held.quantity,
      input,
    );
  }

  const walletIds = new Set(locked.map((allocation) => allocation.walletId));
  if (walletIds.size === 1) {
    const [walletId] = walletIds;
    // Guaranteed by `walletIds.size === 1`; narrows `string | undefined`.
    if (walletId !== undefined) {
      return incrementWallet(
        deps,
        userId,
        'auto_incremented',
        walletId,
        locked,
        held.averageCost,
        held.quantity,
        input,
      );
    }
  }

  return ok({ kind: 'pending', reason: walletIds.size === 0 ? 'no_wallet' : 'ambiguous_split' });
}

async function incrementWallet(
  deps: WalletDependencies,
  userId: UserId,
  kind: 'standing_rule' | 'auto_incremented',
  walletId: WalletId,
  locked: readonly WalletAllocation[],
  averageCostAtBuy: Money,
  heldQuantity: Quantity,
  input: ApplyBuyInput,
): Promise<Result<BuyAllocationOutcome, DomainError>> {
  const existing = locked.find((allocation) => allocation.walletId === walletId);
  const newQuantity = (existing?.quantity ?? Quantity.zero()).plus(input.purchasedQuantity);

  // Defence in depth: BR-010-05 should already hold via the ledger's own
  // guard (a buy that overflows held quantity cannot exist), but the wallet
  // engine never assumes an upstream invariant on a money-adjacent write path.
  const othersTotal = sumQuantity(
    locked
      .filter((allocation) => allocation.walletId !== walletId)
      .map((allocation) => allocation.quantity),
  );
  if (
    input.heldCheck !== 'deferred' &&
    othersTotal.plus(newQuantity).comparedTo(heldQuantity) > 0
  ) {
    return err(
      walletError(WalletErrorCode.ALLOCATION_EXCEEDS_HOLDINGS, {
        assetId: input.assetId,
        held: heldQuantity.toString(),
        requested: othersTotal.plus(newQuantity).toString(),
      }),
    );
  }

  const addedCost = averageCostAtBuy.times(input.purchasedQuantity);
  const allocation: WalletAllocation = {
    userId,
    walletId,
    assetId: input.assetId,
    quantity: newQuantity,
    costBasisAtAllocation: (existing?.costBasisAtAllocation ?? Money.zero()).plus(addedCost),
    allocatedAt: existing?.allocatedAt ?? deps.clock.now(),
  };

  await deps.allocations.upsert(allocation, { effectiveOn: input.effectiveOn, cause: 'buy' });
  return ok({ kind, walletId, allocation });
}
