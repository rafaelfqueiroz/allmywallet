import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, UserId, WalletGoalId, WalletId } from '@/core/shared/ids';
import { Money, sumMoney } from '@/core/shared/money';
import { ok, type Result } from '@/core/shared/result';
import type { WalletGoal } from '@/core/goals/goal';
import { GrowthUnavailable } from '@/core/goals/ports';
import type {
  GoalNotificationPort,
  WalletGoalRepository,
  WalletHolding,
  WalletValuation,
  WalletValuationPort,
} from '@/core/goals/ports';

/**
 * TS-02: hand-written fakes implementing the real port interfaces — no
 * mocking library. TS-01: they let every goals use-case test run with no
 * database; the SQL these stand in for is proven for real in
 * `tests/integration/` and `tests/isolation/`.
 */

export class FakeWalletGoalRepository implements WalletGoalRepository {
  #rows = new Map<WalletGoalId, WalletGoal>();

  /**
   * Counts the writes `markAchieved` actually performed — the assertion behind
   * BR-019-25's "exactly one". A second call on an already-marked goal must
   * leave this untouched.
   */
  markAchievedWrites = 0;

  async findById(id: WalletGoalId): Promise<WalletGoal | null> {
    return this.#rows.get(id) ?? null;
  }

  async listForWallet(walletId: WalletId): Promise<readonly WalletGoal[]> {
    return [...this.#rows.values()].filter((row) => row.walletId === walletId);
  }

  async listAll(): Promise<readonly WalletGoal[]> {
    return [...this.#rows.values()];
  }

  async insert(goal: WalletGoal): Promise<void> {
    this.#rows.set(goal.id, goal);
  }

  async update(goal: WalletGoal): Promise<void> {
    this.#rows.set(goal.id, goal);
  }

  async delete(id: WalletGoalId): Promise<void> {
    this.#rows.delete(id);
  }

  /**
   * BR-019-24/26 — the adapter's `WHERE achieved_on IS NULL`, in memory. The
   * set-once guard is modelled here rather than assumed, because a fake that
   * happily overwrote the marker would let a test pass that the real column
   * would fail.
   */
  async markAchieved(id: WalletGoalId, achievedOn: BusinessDate): Promise<boolean> {
    const existing = this.#rows.get(id);
    if (existing === undefined || existing.achievedOn !== null) return false;
    this.#rows.set(id, { ...existing, achievedOn });
    this.markAchievedWrites += 1;
    return true;
  }

  /** Test setup helper — seeds a row without going through a use case. */
  seed(goal: WalletGoal): void {
    this.#rows.set(goal.id, goal);
  }
}

export class FakeGoalNotificationPort implements GoalNotificationPort {
  readonly sent: { userId: UserId; goalId: WalletGoalId; achievedOn: BusinessDate }[] = [];

  async sendGoalAchieved(
    userId: UserId,
    goalId: WalletGoalId,
    achievedOn: BusinessDate,
  ): Promise<void> {
    this.sent.push({ userId, goalId, achievedOn });
  }
}

/**
 * BR-019-12's pricing, stubbed at the seam rather than reimplemented.
 *
 * The real adapter calls `valueHoldingsAt`; this one multiplies by a price the
 * test states, so every expected figure in a test is arithmetic the test
 * author did by hand. `estimated` is set per asset, which is how a test proves
 * CR-1's marker rides all the way out to the point.
 *
 * It also models the one decision the real adapter makes and this module
 * cannot: an asset marked `needsCostBasis` stands for fixed income, whose
 * value is accrued from the holding's own cost basis, so a `null`
 * `cost_basis_after` makes the whole date unpriceable. Every other asset is
 * priced from quantity alone and does not care what it cost — which is the
 * split `GrowthUnavailable.COST_BASIS_NOT_RECORDED` exists to keep.
 */
export class FakeWalletValuationPort implements WalletValuationPort {
  #prices = new Map<AssetId, Money>();
  #accrued = new Set<AssetId>();
  #needsCostBasis = new Set<AssetId>();

  /** Set on a call to make the port fail, for the propagation branch. */
  failure: DomainError | null = null;

  /** Every call, so a test can assert the wallet's own cost reached the pricer (BR-010-22). */
  readonly seen: { date: BusinessDate; holdings: readonly WalletHolding[] }[] = [];

  price(assetId: AssetId, unitPrice: string, accrued = false): void {
    this.#prices.set(assetId, Money.fromString(unitPrice));
    if (accrued) {
      this.#accrued.add(assetId);
      // Bank paper is the class that accrues, and the class that needs a cost
      // basis to accrue *from*. Tying the two together here keeps the fake
      // from expressing a combination the real valuation cannot produce.
      this.#needsCostBasis.add(assetId);
    }
  }

  async valueOn(
    holdings: readonly WalletHolding[],
    date: BusinessDate,
  ): Promise<Result<WalletValuation, DomainError>> {
    this.seen.push({ date, holdings });
    if (this.failure !== null) return { ok: false, error: this.failure };

    const unpriceable = holdings.some(
      (holding) => holding.costBasisAfter === null && this.#needsCostBasis.has(holding.assetId),
    );
    if (unpriceable) {
      return ok({ kind: 'unpriceable', reason: GrowthUnavailable.COST_BASIS_NOT_RECORDED });
    }

    const value = sumMoney(
      holdings.map((holding) => {
        const price = this.#prices.get(holding.assetId) ?? Money.zero();
        return price.times(holding.quantity);
      }),
    );
    return ok({
      kind: 'valued',
      value,
      estimated: holdings.some((holding) => this.#accrued.has(holding.assetId)),
    });
  }
}
