import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, WalletId } from '@/core/shared/ids';
import { Money, Quantity, sumQuantity } from '@/core/shared/money';
import { ok, type Result } from '@/core/shared/result';
import { distributeExact } from '@/core/reporting/base-query';
import type { AllocationEvent, EarningRecord, ReportingErrorCode } from '@/core/reporting/ports';

/**
 * SPEC-014 BR-014-12 / DL-014-05 — **income belongs to the wallet that held
 * the asset when the money arrived**, not to whichever wallet holds it today.
 *
 * The alternative is not merely less accurate, it is unstable: moving a
 * holding into "Aposentadoria" this afternoon would rewrite years of that
 * wallet's income history, and the user would watch a number change with
 * nothing about the past having changed. That is the defect this whole module
 * exists to prevent, and it is why `wallet_allocation_events` exists at all.
 *
 * **The denominator is the quantity B3 states on the payment row.** A provento
 * is paid on a number of shares, and the extract records it — so the share of
 * the payment that no wallet had claimed is `paid_on − Σ allocated`, and it
 * lands in Unassigned exactly as BR-011-09 requires. Recovering the held
 * quantity any other way would mean replaying the position, which is the five
 * year replay DL-011-07 forbids a report from doing.
 */

/** What each wallet held of each asset, as at one date. */
export type AllocationSnapshot = ReadonlyMap<AssetId, ReadonlyMap<WalletId, Quantity>>;

/**
 * Fold the event log into the state as at `date`.
 *
 * Last write wins per `(asset, wallet)`, which is what makes this a log of
 * states rather than of deltas: no arithmetic, so no way for the fold to drift
 * from the log.
 *
 * A zero is **kept, not dropped**. "This wallet now holds none of this asset"
 * is how a sale or a reassignment is recorded, and it is a state rather than an
 * absence — dropping it would be indistinguishable from never having held any,
 * and it would leave the previous quantity standing for every later date. As a
 * weight of zero it takes no share of a payment, which is the correct outcome
 * without a special case.
 *
 * Events must arrive oldest-first; the port guarantees it, and relying on the
 * database's ordering rather than re-sorting here keeps one definition of
 * "which of two changes on the same day came second" (`created_at`).
 */
export function allocationAt(
  events: readonly AllocationEvent[],
  date: BusinessDate,
): AllocationSnapshot {
  const byAsset = new Map<AssetId, Map<WalletId, Quantity>>();

  for (const event of events) {
    if (event.effectiveOn > date) continue;
    const wallets = byAsset.get(event.assetId) ?? new Map<WalletId, Quantity>();
    wallets.set(event.walletId, event.quantity);
    byAsset.set(event.assetId, wallets);
  }

  return byAsset;
}

/** One provento, or the part of one that belonged to a single wallet. */
export interface EarningSlice {
  readonly earning: EarningRecord;
  /** `null` is BR-011-09's Unassigned — the part no wallet had claimed. */
  readonly walletId: WalletId | null;
  readonly amount: Money;
}

/**
 * Split one payment across the wallets that held the asset on its pay date.
 *
 * Three cases the arithmetic has to survive, all of them real:
 *
 *  - **Nothing allocated.** The whole payment is Unassigned. This is the
 *    common case for a user who has not filed anything into wallets yet, and
 *    it must not vanish from the report.
 *  - **The row states no quantity.** A hand-entered provento can carry zero
 *    (SPEC-006 allows it). There is then no held quantity to compare against,
 *    so the allocations are all there is to go on and the split is over them
 *    alone — stated rather than silently treated as fully unassigned.
 *  - **Allocations exceed the paid-on quantity.** A stale allocation for a
 *    position since reduced, which `reconcile-allocations.ts` repairs when it
 *    next runs. Clamping the Unassigned remainder at zero keeps the slices
 *    summing to the payment; letting it go negative would make a wallet's
 *    income exceed the portfolio's.
 *
 * `distributeExact` does the division — the same splitter the holdings path
 * uses, so a repeating decimal loses nothing here either (TS-11) and the
 * slices sum to the payment exactly.
 */
export function attributeEarning(
  earning: EarningRecord,
  allocations: AllocationSnapshot,
): readonly EarningSlice[] {
  const wallets = [...(allocations.get(earning.assetId) ?? new Map<WalletId, Quantity>())];
  const unattributed = [{ earning, walletId: null, amount: earning.amount }];

  if (wallets.length === 0) return unattributed;

  const allocated = sumQuantity(wallets.map(([, quantity]) => quantity));
  const paidOn = earning.quantity;
  const unassigned =
    paidOn.isZero() || !paidOn.minus(allocated).isPositive()
      ? Quantity.zero()
      : paidOn.minus(allocated);

  const weights = [...wallets.map(([, quantity]) => quantity), unassigned];
  const split = distributeExact(earning.amount, weights);
  /**
   * Nothing to apportion *by*: every wallet holds zero and the row states no
   * quantity, which happens when a hand-entered provento arrives on an asset
   * whose allocations were emptied before the pay date. The payment is still
   * real and still belongs in the total, so it goes to Unassigned rather than
   * failing the report. **A payment is never lost** — that is the invariant
   * this branch exists to keep.
   */
  if (!split.ok) return unattributed;

  const slices: EarningSlice[] = wallets.map(([walletId], index) => ({
    earning,
    walletId,
    // Non-null: `split` was computed from this same array.
    amount: split.value[index] as Money,
  }));

  const remainder = split.value[wallets.length] as Money;
  if (!remainder.isZero()) {
    slices.push({ earning, walletId: null, amount: remainder });
  }

  // A wallet holding zero takes a zero slice, which is noise in every fold
  // downstream — the share, the ranking and the breakdown would all carry a
  // group that received nothing.
  return slices.filter((slice) => !slice.amount.isZero());
}

/**
 * Every payment in the period, split by the wallets that held it **at the time
 * of each payment** — so the fold is re-evaluated per pay date rather than
 * once for the period.
 *
 * That is the whole point: a holding moved between wallets in June must show
 * its April income under the old wallet and its August income under the new
 * one. Evaluating the allocation once, at either end of the period, would
 * produce exactly the retroactive rewrite BR-014-12 forbids.
 */
export function attributeAll(
  earnings: readonly EarningRecord[],
  events: readonly AllocationEvent[],
): readonly EarningSlice[] {
  const slices: EarningSlice[] = [];
  // Memoised by pay date: a portfolio pays on a few dozen distinct dates in a
  // period, and each fold walks the whole log.
  const snapshots = new Map<BusinessDate, AllocationSnapshot>();

  for (const earning of earnings) {
    let snapshot = snapshots.get(earning.payDate);
    if (snapshot === undefined) {
      snapshot = allocationAt(events, earning.payDate);
      snapshots.set(earning.payDate, snapshot);
    }

    slices.push(...attributeEarning(earning, snapshot));
  }

  return slices;
}
