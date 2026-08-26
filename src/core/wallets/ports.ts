import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId, UserId, WalletId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
import type { Wallet } from '@/core/wallets/wallet';

/**
 * AR-02: ports declared in `core/`, next to the use cases that need them.
 * `adapters/db/wallet-repository.ts` implements all three; hand-written fakes
 * in `test-support/` implement them for use-case tests (TS-02).
 */

export interface WalletRepository {
  findById(id: WalletId): Promise<Wallet | null>;
  list(): Promise<readonly Wallet[]>;
  insert(wallet: Wallet): Promise<void>;
  update(wallet: Wallet): Promise<void>;
  /** BR-010-07: deleting a wallet never deletes transactions — only this row. */
  delete(id: WalletId): Promise<void>;
}

/**
 * DM-2 — one row per `(user, wallet, asset)`, unique on that triple.
 * `costBasisAtAllocation` and `allocatedAt` are nullable because a row can be
 * scaled by a corporate event or reduced by a sale without ever having its
 * own cost basis recomputed from scratch (see `apply-corporate-event.ts`).
 */
export interface WalletAllocation {
  readonly userId: UserId;
  readonly walletId: WalletId;
  readonly assetId: AssetId;
  readonly quantity: Quantity;
  /**
   * BR-010-22: the wallet's own accumulated cost of its allocated shares,
   * frozen the way SPEC-007's `totalCost` is — a split/grupamento/bonificação
   * leaves it untouched (BR-007-04's analogy, cited in
   * `apply-corporate-event.ts`), a sale reduces it proportionally with the
   * quantity it accompanies, and an assignment or auto-increment sets it from
   * the position's average cost at that moment. Nullable because the schema
   * (DM-2) allows a row with no cost information yet.
   */
  readonly costBasisAtAllocation: Money | null;
  readonly allocatedAt: Date | null;
}

/**
 * THE SUM INVARIANT (BR-010-05) — `sum(allocations for an asset) <= held
 * quantity` — spans rows and cannot be a single-row CHECK constraint.
 *
 * `lockForAsset` is how it is enforced: it must run `SELECT ... FOR UPDATE`
 * over every allocation row for the asset, **inside the same `withTenant`
 * transaction** as whatever write follows it (`allocate.ts`, `apply-buy.ts`,
 * `apply-sell.ts`, `apply-corporate-event.ts` all call it first). Two
 * concurrent allocations against the same asset then serialise on the lock
 * rather than both reading a total that is stale by the time either writes —
 * without it, two allocations that each individually fit under the held
 * quantity could both be accepted and jointly exceed it.
 *
 * The database does **not** enforce this on its own — there is no
 * `CHECK (sum(...) <= held)` possible in Postgres. Every write path in this
 * module goes through the port's locked read for exactly that reason; a
 * caller that reads `listForAsset` and writes without going through
 * `lockForAsset` first has reintroduced the race.
 */
/**
 * SPEC-014 BR-014-12 — why an allocation write carries a date and a reason.
 *
 * `wallet_allocations` is current state: it cannot say what a wallet held on
 * the day a provento was paid, and attributing last year's income with today's
 * split would rewrite a wallet's income history whenever a holding is
 * reassigned (DL-014-05). So every change appends to
 * `wallet_allocation_events`, and the caller supplies the two things the
 * repository cannot know.
 *
 * **`effectiveOn` is the trade date, not today.** A user importing four years
 * of B3 extracts creates four years of allocation history in one afternoon;
 * stamping those with the clock would leave every past provento attributed to
 * a wallet that, as far as the log knew, held nothing at the time. AR-29
 * applies here as everywhere: the date the movement happened.
 *
 * It is a required argument rather than an option with a default for one
 * reason: a default would be silently wrong on the import path, which is the
 * path that matters most. Making it required turns "which date is this?" into
 * a compile error at every call site.
 */
export type AllocationChangeCause =
  'assignment' | 'buy' | 'sale' | 'corporate_event' | 'wallet_deleted';

export interface AllocationChange {
  readonly effectiveOn: BusinessDate;
  readonly cause: AllocationChangeCause;
}

export interface WalletAllocationRepository {
  /** Unlocked read, for display paths that do not write. */
  listForAsset(assetId: AssetId): Promise<readonly WalletAllocation[]>;
  listForWallet(walletId: WalletId): Promise<readonly WalletAllocation[]>;
  /** Every allocation this tenant has, for the Unassigned computation (BR-010-06). */
  listAll(): Promise<readonly WalletAllocation[]>;
  /** `SELECT ... FOR UPDATE` — see the invariant note above. Must run inside `withTenant`. */
  lockForAsset(assetId: AssetId): Promise<readonly WalletAllocation[]>;
  /** Insert or replace the `(wallet, asset)` row, and record the change. */
  upsert(allocation: WalletAllocation, change: AllocationChange): Promise<void>;
  delete(walletId: WalletId, assetId: AssetId, change: AllocationChange): Promise<void>;
  /** BR-010-07: a deleted wallet's allocations disappear, which is what "returns to Unassigned" means for an implicit bucket. */
  deleteForWallet(walletId: WalletId, change: AllocationChange): Promise<void>;
}

/**
 * SPEC-017 — one stored manual target. Rows exist in `manual` mode only;
 * equal weight derives `100 / n` on read and stores nothing (BR-017-05), which
 * is what makes BR-017-06's automatic recompute free.
 */
export interface StoredWalletTarget {
  readonly walletId: WalletId;
  readonly assetId: AssetId;
  /** BR-017-03: a percentage of market value, 0–100. */
  readonly targetPct: Quantity;
}

/**
 * THE 100 % INVARIANT (BR-017-04) — `sum(target_pct) = 100` per wallet — spans
 * rows and cannot be a single-row CHECK constraint, exactly like
 * `WalletAllocationRepository`'s sum invariant above.
 *
 * `lockForWallet` is how it is enforced: it must take a row lock covering the
 * wallet's target set **inside the same `withTenant` transaction** as the write
 * that follows (`targets.ts`'s `setWalletTargets` is the only caller, and takes
 * it before it validates anything). Two concurrent edits then serialise rather
 * than both reading a set that is stale by the time either writes — without it,
 * two edits that each individually total 100 could interleave into a stored set
 * that does not, and no constraint in the database would notice.
 *
 * It locks the **wallet** row rather than the target rows, which is the one
 * place this differs from `lockForAsset`. `SELECT ... FOR UPDATE` locks only
 * rows that exist, and a wallet defining targets for the first time has none —
 * the phantom gap `lockForAsset` closes by also locking `positions`. A wallet
 * always has its own row, so locking that closes the gap with no second query.
 */
export interface WalletTargetRepository {
  /** Unlocked read, for display paths that do not write. */
  listForWallet(walletId: WalletId): Promise<readonly StoredWalletTarget[]>;
  /** Every target this tenant has, for the balance sweep behind the "Needs attention" queue. */
  listAll(): Promise<readonly StoredWalletTarget[]>;
  /** `SELECT ... FOR UPDATE` on the wallet — see the invariant note above. Must run inside `withTenant`. */
  lockForWallet(walletId: WalletId): Promise<readonly StoredWalletTarget[]>;
  /**
   * The wallet's target set becomes exactly `targets`, in one statement pair.
   * Replace rather than upsert: a target set is validated as a whole against
   * BR-017-04, so persisting it a row at a time would leave the table holding
   * sets that never totalled 100 between statements.
   */
  replaceForWallet(walletId: WalletId, targets: readonly StoredWalletTarget[]): Promise<void>;
}

export interface StandingRule {
  readonly assetId: AssetId;
  readonly walletId: WalletId;
}

export interface WalletAssetRuleRepository {
  /** BR-010-14: opt-in, off by default — `null` is the default state. */
  find(assetId: AssetId): Promise<WalletId | null>;
  /**
   * Every rule this tenant has set (#61).
   *
   * `find` alone was enough for `apply-buy.ts`, which asks about one asset at
   * a time — and so a rule, once set, could never be seen or removed: there
   * was no way to enumerate them, `clearStandingRuleAction` had no caller, and
   * a standing instruction to route every future purchase of an asset was
   * permanent by accident.
   */
  list(): Promise<readonly StandingRule[]>;
  set(assetId: AssetId, walletId: WalletId): Promise<void>;
  clear(assetId: AssetId): Promise<void>;
  clearForWallet(walletId: WalletId): Promise<void>;
}

/** One asset's position, aggregated across institutions (SPEC-007 BR-007-08). */
export interface AssetPositionQuery {
  readonly assetId: AssetId;
  readonly quantity: Quantity;
  readonly averageCost: Money;
}

/**
 * AR-02/AR-03: the seam between wallets and SPEC-007's position cache.
 * Wallets allocate against **held quantity** — it never replays the ledger
 * itself (BR-010-08's "wallets are views", extended to mean views over
 * positions too, not a second calculation engine).
 */
export interface PositionQueryPort {
  /** Zero quantity/cost for an asset never held — not an error (BR-010-16). */
  query(assetId: AssetId): Promise<AssetPositionQuery>;
  /** Every asset this tenant currently holds a non-zero quantity of. */
  listHeld(): Promise<readonly AssetPositionQuery[]>;
}
