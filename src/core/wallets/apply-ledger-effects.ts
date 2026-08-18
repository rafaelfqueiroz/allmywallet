import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, UserId, WalletId } from '@/core/shared/ids';
import { sumQuantity } from '@/core/shared/money';
import { err, ok, type Result } from '@/core/shared/result';
import type { Transaction } from '@/core/ledger/transaction';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import { WalletErrorCode, walletError } from '@/core/wallets/errors';
import { applyBuy, type BuyAllocationOutcome } from '@/core/wallets/apply-buy';
import { applySell } from '@/core/wallets/apply-sell';
import { applyCorporateEventToAllocations } from '@/core/wallets/apply-corporate-event';

/**
 * SPEC-010 BR-010-10/14/15/17/18 — the bridge from "transactions landed in the
 * ledger" to "allocations reflect them".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 *
 * `applyBuy`, `applySell` and `applyCorporateEventToAllocations` were written,
 * unit-tested and then never called by anything. The four rules above were
 * ticked as done on the strength of those tests, and none of them held at
 * runtime. BR-010-17 is the one that did damage rather than merely omitting a
 * convenience: a sale shrinks the position but left allocations untouched, so
 * the BR-010-05 invariant — total allocated never exceeds quantity held — was
 * violable by any sell of a fully-allocated asset.
 *
 * A use case with no caller passes every test it has. This module is the
 * caller, and `tests/integration/import-pipeline.test.ts` is what stops it
 * becoming orphaned again.
 * ---------------------------------------------------------------------------
 *
 * **Chronological order, not grouped by kind.** A batch can carry a split, a
 * buy and a sell for the same asset, and applying all splits first would scale
 * a quantity that had not been bought yet. Positions replay in trade-date
 * order (SPEC-007), and allocations are a view over the same history, so they
 * must be walked the same way or the two disagree about the same batch.
 */

/**
 * BR-010-18 / SPEC-007 BR-007-04 — the two events that carry their ratio.
 *
 * **A bonificação is deliberately absent, and that is a stated gap rather than
 * an oversight.** BR-010-18 names it, but a bonificação expresses its effect
 * as an absolute bonus *quantity*, not a ratio (`transaction.ratio` is null),
 * so the equivalent ratio is `(held + bonus) / held` and needs the whole-asset
 * quantity as it stood immediately before the event. This module reads no
 * positions on purpose — it is a fold over transactions — and inventing a
 * ratio of 1 would silently claim the event had no effect on allocations when
 * it did. Tracked on #13.
 */
const RATIO_EVENTS = new Set(['split', 'grupamento']);

/**
 * BR-010-05/BR-010-17 — the types that take shares *away*.
 *
 * `sell` was the only one handled, and the other two break the invariant in
 * exactly the same way: `core/positions/apply-transaction.ts` shrinks the
 * position for a `transfer_out` (shares left for another custodian) and for a
 * negative `adjustment` (BR-005-24's reconciliation correction, where the
 * sign of the quantity carries the direction). Allocations that do not follow
 * leave allocated > held, and `computeUnassigned` filters to positive
 * remainders — so the contradiction did not even render as a warning: the
 * screen showed a wallet holding shares the user no longer owned.
 *
 * They share `applySell`'s proportional reduction because they raise the same
 * question and have the same answer: the event says how many shares left, and
 * nothing about which purpose they served (DL-010-05).
 *
 * The types that *add* quantity — `transfer_in`, `subscription`,
 * `bonificacao`, a positive `adjustment` — are deliberately not here. They
 * leave the new shares unallocated, which is BR-010-16's brand-new-holding
 * behaviour and lands them in the Needs attention queue rather than breaking
 * an invariant. Auto-following the existing split would be the same guess
 * BR-010-11 refuses on the buy side. Tracked separately on #13.
 */
const REDUCING_TYPES = new Set(['sell', 'transfer_out']);

export interface AllocationMade {
  readonly assetId: AssetId;
  readonly outcome: BuyAllocationOutcome;
}

export interface LedgerEffectsOptions {
  /**
   * SPEC-010 BR-010-17 / AC-010-15 — "a sale with a specified wallet reduces
   * only that wallet".
   *
   * `applySell` has taken a `walletId` since it was written and nothing ever
   * passed one, so the rule held in unit tests and nowhere else. This is the
   * parameter that carries the user's statement from the manual entry form to
   * the use case that implements it (#61).
   *
   * **It applies to every reducing row in the call**, which is safe only
   * because the one caller that sets it submits a single transaction. An
   * imported batch must never set it: a B3 extract says how many shares left
   * and nothing about which purpose they served, so BR-010-17's proportional
   * reduction is the documented answer there, and inferring a wallet from the
   * existing split would be the same guess BR-010-11 refuses on the buy side.
   */
  readonly soldFromWallet?: WalletId;
}

export interface LedgerEffectsSummary {
  /** BR-010-15: every allocation this commit made, and every purchase it left pending. */
  readonly allocations: readonly AllocationMade[];
}

/**
 * Applied inside the caller's existing tenant transaction — never its own.
 * A commit that wrote transactions and then failed to adjust allocations
 * leaves the sum invariant broken with no retry that repairs it, so the two
 * have to succeed or fail together (AR-11, AR-19).
 */
export async function applyLedgerEffects(
  deps: WalletDependencies,
  userId: UserId,
  transactions: readonly Transaction[],
  options: LedgerEffectsOptions = {},
): Promise<Result<LedgerEffectsSummary, DomainError>> {
  const allocations: AllocationMade[] = [];
  const touched = new Set<AssetId>();

  for (const transaction of inTradeDateOrder(transactions)) {
    // BR-006-03: only `active` rows enter calculations, and an allocation is a
    // calculation over the same ledger. An `unclassified` row is deliberately
    // stored and deliberately inert (DL-006-06).
    if (transaction.status !== 'active') continue;

    touched.add(transaction.assetId);

    if (transaction.type === 'buy') {
      const result = await applyBuy(deps, userId, {
        assetId: transaction.assetId,
        purchasedQuantity: transaction.quantity,
        heldCheck: 'deferred',
      });
      if (!result.ok) return result;
      allocations.push({ assetId: transaction.assetId, outcome: result.value });
      continue;
    }

    /**
     * An `adjustment` carries its direction in the **sign** of the quantity
     * (SPEC-005 BR-005-24), so it is the one type whose effect cannot be read
     * from `transaction.type` alone. Only the negative half reduces; the
     * positive half adds shares that stay unallocated, like any other arrival.
     */
    const reduction =
      transaction.type === 'adjustment' && transaction.quantity.isNegative()
        ? transaction.quantity.negated()
        : REDUCING_TYPES.has(transaction.type)
          ? transaction.quantity
          : null;

    if (reduction !== null) {
      // AC-010-15: `soldFromWallet` when the user said which wallet sold —
      // manual entry only. Absent, this is an imported reduction, which
      // carries no statement of which purpose it served; BR-010-17's
      // proportional reduction is the documented answer for exactly that case,
      // and inferring one from the split would be the same guess BR-010-11
      // refuses to make on the buy side.
      //
      // Spread rather than passed as `undefined` — `exactOptionalPropertyTypes`
      // distinguishes "absent" from "present and undefined", and `applySell`
      // branches on `!== undefined`.
      const result = await applySell(deps, userId, {
        assetId: transaction.assetId,
        soldQuantity: reduction,
        ...(options.soldFromWallet === undefined ? {} : { walletId: options.soldFromWallet }),
      });
      if (!result.ok) return result;
      continue;
    }

    if (RATIO_EVENTS.has(transaction.type)) {
      const ratio = transaction.ratio;
      // A split row with no ratio is a malformed row, not a 1:1 split.
      // Scaling by an assumed 1 would record that the event was applied and
      // had no effect, which is a different and less recoverable claim than
      // "this row could not be applied".
      if (ratio === null) continue;
      const result = await applyCorporateEventToAllocations(
        deps,
        userId,
        transaction.assetId,
        ratio,
      );
      if (!result.ok) return result;
    }
  }

  const invariant = await assertWithinHoldings(deps, touched);
  if (!invariant.ok) return invariant;

  return ok({ allocations });
}

/**
 * BR-010-05, checked once for the whole batch.
 *
 * This is the other half of `applyBuy`'s `heldCheck: 'deferred'`. The
 * position cache reflects every transaction in the batch, so it is the right
 * thing to compare against exactly once — at the end — and the wrong thing to
 * compare against at any intermediate step. Verifying per asset rather than
 * per transaction is also what makes a round trip commit while a genuine
 * over-allocation still fails.
 */
async function assertWithinHoldings(
  deps: WalletDependencies,
  assetIds: ReadonlySet<AssetId>,
): Promise<Result<true, DomainError>> {
  for (const assetId of assetIds) {
    const allocated = sumQuantity(
      (await deps.allocations.listForAsset(assetId)).map((allocation) => allocation.quantity),
    );
    const held = await deps.positionQuery.query(assetId);
    if (allocated.comparedTo(held.quantity) > 0) {
      return err(
        walletError(WalletErrorCode.ALLOCATION_EXCEEDS_HOLDINGS, {
          assetId,
          held: held.quantity.toString(),
          requested: allocated.toString(),
        }),
      );
    }
  }
  return ok(true);
}

/**
 * Stable within a date: two transactions on the same day are applied in the
 * order the ledger produced them, so a rerun over the same batch reaches the
 * same allocations (DM-4's spirit, applied to wallets).
 */
function inTradeDateOrder(transactions: readonly Transaction[]): readonly Transaction[] {
  return [...transactions].sort((a, b) =>
    a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0,
  );
}
