import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, UserId, WalletGoalId, WalletId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
import type { Result } from '@/core/shared/result';
import type { AllocationEvent } from '@/core/reporting/ports';
import type { WalletGoal } from '@/core/goals/goal';

/**
 * SPEC-019 — AR-02: ports declared in `core/`, next to the use cases that need
 * them. `adapters/db/` implements the repository; hand-written fakes in
 * `test-support/` implement all of them for use-case tests (TS-02).
 */

export interface WalletGoalRepository {
  findById(id: WalletGoalId): Promise<WalletGoal | null>;
  listForWallet(walletId: WalletId): Promise<readonly WalletGoal[]>;
  listAll(): Promise<readonly WalletGoal[]>;
  insert(goal: WalletGoal): Promise<void>;
  update(goal: WalletGoal): Promise<void>;
  /** BR-010-07's shape, for goals: deleting a goal deletes this row and nothing else. */
  delete(id: WalletGoalId): Promise<void>;
  /**
   * BR-019-24/26 — **set once. Never cleared, never moved to a later date.**
   *
   * The implementation must be `UPDATE … SET achieved_on = $2 WHERE id = $1
   * AND achieved_on IS NULL`, and must report **whether that UPDATE actually
   * matched a row**. Set-once belongs in the write, not in a caller
   * remembering to check first: BR-019-25 allows exactly one achievement
   * email, and a second evaluation racing the first would otherwise mark and
   * notify twice.
   *
   * **The return value is what makes that true, and it is not optional.**
   * `withTenant` runs at READ COMMITTED, so two overlapping renders can both
   * read `achieved_on IS NULL`, and the second UPDATE will then re-evaluate
   * against the committed row, match nothing, and return quietly. A caller
   * that could not see the difference would send the email anyway — two
   * emails for one achievement, from a page that writes on every GET.
   * `recordAchievement` sends only when this returns `true`.
   */
  markAchieved(id: WalletGoalId, achievedOn: BusinessDate): Promise<boolean>;
}

/**
 * SPEC-014 BR-014-12's allocation event, plus the wallet's own cost.
 *
 * `wallet_allocation_events` gains a nullable `cost_basis_after` in this
 * change: the wallet's accumulated cost of its allocated shares after the
 * change, mirroring `wallet_allocations.cost_basis_at_allocation` (SPEC-010
 * BR-010-22). It is the wallet's cost, not the position's — which is the
 * whole reason BR-010-22 records it separately.
 *
 * **`null` is not zero.** The column is not backfilled, so every event written
 * before the migration reads `null`, and a wallet whose history is entirely
 * pre-migration has no invested line at all rather than a flat line at zero.
 * `growth-progress.ts` turns that into an explicitly unavailable point; see
 * `GrowthUnavailable.COST_BASIS_NOT_RECORDED` for why refusing beats summing
 * what is known.
 */
export interface GoalAllocationEvent extends AllocationEvent {
  readonly costBasisAfter: Money | null;
}

/** What one wallet held of one asset on a date, and what the wallet paid for it. */
export interface WalletHolding {
  readonly assetId: AssetId;
  readonly quantity: Quantity;
  /**
   * BR-010-22 — the **wallet's** accumulated cost of these shares, not the
   * position's. `null` where `wallet_allocation_events.cost_basis_after` was
   * never recorded; see `GrowthUnavailable.COST_BASIS_NOT_RECORDED`. Never
   * read as zero.
   */
  readonly costBasisAfter: Money | null;
}

/**
 * **Why a point on the burn-up can carry no value at all.**
 *
 * A typed absence rather than a zero, for the reason
 * `core/reporting/snapshot-derived.ts` gives at length: the series is complete
 * and correct, and one of its points does not exist. It is declared here
 * rather than added to `HistoryUnavailable` because it is not a fact about
 * `daily_valuation_snapshots` — it is a fact about a column on
 * `wallet_allocation_events`, and folding it into that enum would make one
 * sentence on screen answer for two unrelated silences.
 */
export const GrowthUnavailable = {
  /**
   * BR-019-11 — an asset the wallet held on this date has no recorded
   * `cost_basis_after`, and the figure being drawn needs one.
   *
   * The column is **not backfilled**, so every event written before this
   * change reads `null`. A `null` is not a zero and a point built from one is
   * not a zero either:
   *
   *  - summing only the assets that *do* have a cost would understate the line
   *    by exactly the assets whose cost is unknown, and the understatement is
   *    invisible — the line still looks like a line;
   *  - reading `null` as zero would draw a wallet that invested nothing.
   *
   * **Which basis this stops differs, and the difference is the point.** The
   * `invested` line *is* the cost, so one unknown cost makes it unanswerable.
   * The `current_value` line is a market value, and for a listed asset the
   * wallet's cost is not an input to it at all — quantity × price needs no
   * cost — so an unknown cost there costs nothing and the point is drawn.
   * Fixed income is the exception: `core/valuation/accrual.ts` values bank
   * paper by applying a factor to the holding's own cost basis, so with no
   * cost there is nothing to accrue from and the point genuinely cannot be
   * priced.
   *
   * That split is decided by `WalletValuationPort`, because deciding it needs
   * the asset's **class**, which `core/goals` has no other use for and would
   * have to grow a port to learn. Refusing the whole point regardless of class
   * would be the safe-looking choice and the wrong one: it would make SPEC-019
   * refuse a wallet's current value on dates where SPEC-013's Portfolio Value
   * answers it happily, and the two reconciling is an acceptance criterion.
   */
  COST_BASIS_NOT_RECORDED: 'COST_BASIS_NOT_RECORDED',
  /**
   * BR-009-13's cost floor, reached on a holding whose cost is **also**
   * unknown — so there is no floor either.
   *
   * `valueListed` values an unpriceable holding at `averageCost × quantity`
   * rather than dropping it, which is SPEC-009's deliberate choice: a
   * conservative figure beats a silent omission. That choice depends on the
   * cost being real. Where `cost_basis_after` was never recorded, the adapter
   * has nothing to pass but zero, and the floor becomes a fabricated
   * R$ 0,00 — a wallet drawn as worthless on every date before quote coverage
   * begins, which is every date for an imported five-year history.
   *
   * Separate from `COST_BASIS_NOT_RECORDED` because the sentence to the user
   * is different: there the cost is what is missing and the figure asked for
   * *is* the cost, here the cost is missing and so is the price. Folding them
   * would make one message answer for two different silences — the same
   * reasoning `snapshot-derived.ts` gives for keeping its three apart.
   */
  PRICE_UNAVAILABLE: 'PRICE_UNAVAILABLE',
} as const;
export type GrowthUnavailable = (typeof GrowthUnavailable)[keyof typeof GrowthUnavailable];

/**
 * The wallet's market value on one sampled date, or a statement that it has
 * none.
 *
 * A union rather than a nullable figure, so an adapter that cannot price a
 * date has to say so and a renderer cannot format the absence as `R$ 0,00`.
 */
export type WalletValuation =
  | {
      readonly kind: 'valued';
      readonly value: Money;
      /** BR-019-12 / CR-1 — true when any part of the figure is accrued rather than observed. */
      readonly estimated: boolean;
    }
  | { readonly kind: 'unpriceable'; readonly reason: GrowthUnavailable };

/**
 * BR-019-12 — the wallet's market value on each sampled date, priced by the
 * same `valueHoldingsAt` every other surface uses.
 *
 * AR-03: the seam is real. `core/valuation/holdings.ts` is the one function
 * that values a holding, and it needs a `ValuationContext` — quote history, a
 * trading calendar, fixed-income contracts, CDI and IPCA series — none of
 * which this module has any other use for. Valuing here instead would be a
 * second implementation of the same arithmetic, and the two would eventually
 * disagree with the Portfolio Value chart on the next screen over, which is
 * exactly the divergence SPEC-013 DL-013-06 calls the most trust-destroying
 * defect this product could ship.
 */
export interface WalletValuationPort {
  valueOn(
    holdings: readonly WalletHolding[],
    date: BusinessDate,
  ): Promise<Result<WalletValuation, DomainError>>;
}

/**
 * BR-019-25 — one email on achievement, where the user has opted in.
 *
 * **Not a second notification path.** Consent is SPEC-004's
 * `email_reminders` purpose, read through SPEC-004's own `ConsentRepository`;
 * this port is the send, declared here for the same reason
 * `core/privacy/ports.ts` declares `NotificationPort` there — next to the use
 * case that needs it. No email provider exists in this codebase yet: no
 * subprocessor is chosen, there is no credential in `src/lib/env.ts`, and
 * `src/adapters/notifications/log-notification-adapter.ts` logs that a
 * notification *would* have been sent rather than faking a "sent" status. The
 * implementation of this port follows that precedent exactly, and the gap is
 * reported rather than papered over.
 */
export interface GoalNotificationPort {
  sendGoalAchieved(userId: UserId, goalId: WalletGoalId, achievedOn: BusinessDate): Promise<void>;
}
