import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId, WalletId } from '@/core/shared/ids';
import { Quantity, sumQuantity, type Money } from '@/core/shared/money';
import { distributeExact } from '@/core/reporting/base-query';
import type { AllocationEvent, EarningRecord } from '@/core/reporting/ports';

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
 * **The denominator is the quantity held on the pay date.** For a dividend,
 * JCP, rendimento or amortization that is the quantity B3 states on the
 * payment row — a provento is paid on a number of shares, and the extract
 * records it — so the share no wallet had claimed is `held − Σ allocated`, and
 * it lands in Unassigned exactly as BR-011-09 requires.
 *
 * A `leilao_fracoes` row is the exception (#113 review): its quantity is the
 * fraction B3 sold (0,2 of a share), not a count the cash was paid on, so it
 * arrives with `heldQuantity` — the position on the pay date, which the port
 * derives for these rows alone — and that is the denominator instead. The
 * auction cash is income on the whole position the fraction came from, so it
 * splits in the same proportions a dividend paid that day would.
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
 *  - **Allocations exceed the held quantity.** A stale allocation for a
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
  const paidOn = heldOnPayDate(earning);
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
 * BR-014-12 — the quantity the payment is apportioned by.
 *
 * Worked example (DV-17), a leilão de frações: ITSA4 held 105 on the pay date,
 * Aposentadoria holding 10 of them, and B3 paid 0,2 × 14,00 = 2,80 for the
 * fraction. The row's quantity is 0,2, and `0,2 − 10` clamps Unassigned to
 * zero — 2,80 to Aposentadoria, which held a tenth of the position. Over the
 * held 105 instead: Unassigned is 105 − 10 = 95, and the weights 10 : 95 give
 * Aposentadoria 2,80 × 10 ÷ 105 = 0,2666… (0,26666667 at the stored eight
 * places, R$ 0,27 displayed) and Unassigned the residual 2,53333333
 * (R$ 2,53).
 */
function heldOnPayDate(earning: EarningRecord): Quantity {
  return earning.type === 'leilao_fracoes' ? earning.heldQuantity : earning.quantity;
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
