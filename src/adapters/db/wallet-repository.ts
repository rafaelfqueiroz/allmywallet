import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { AssetId, InstitutionId, type UserId, WalletId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { aggregateAcrossInstitutions } from '@/core/positions/aggregate';
import type { PositionSnapshot } from '@/core/positions/replay';
import type {
  AllocationChange,
  AssetPositionQuery,
  PositionQueryPort,
  StoredWalletTarget,
  WalletAllocation,
  WalletAllocationRepository,
  StandingRule,
  WalletAssetRuleRepository,
  WalletRepository,
  WalletTargetRepository,
} from '@/core/wallets/ports';
import { isTargetMode, type TargetMode } from '@/core/wallets/targets';
import type { Wallet } from '@/core/wallets/wallet';
import { positions } from '@/db/schema/positions';
import {
  walletAllocationEvents,
  walletAllocations,
  walletAssetRules,
  walletTargets,
  wallets,
} from '@/db/schema/wallets';
import type { Tx } from '@/db/tenant';

/**
 * SPEC-010's persistence. AR-11: every method runs on a `Tx` obtained from
 * `withTenant`; RLS supplies the tenant filter on reads and `WITH CHECK`
 * verifies it on writes, so `user_id` is written explicitly on every insert
 * but never added redundantly to a WHERE clause.
 */
export class DrizzleWalletRepository implements WalletRepository {
  constructor(
    private readonly tx: Tx,
    private readonly userId: UserId,
  ) {}

  async findById(id: WalletId): Promise<Wallet | null> {
    const [row] = await this.tx.select().from(wallets).where(eq(wallets.id, id));
    return row ? toWalletDomain(row) : null;
  }

  async list(): Promise<readonly Wallet[]> {
    const rows = await this.tx.select().from(wallets);
    return rows.map(toWalletDomain);
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.tx.insert(wallets).values(toWalletRow(wallet, this.userId));
  }

  async update(wallet: Wallet): Promise<void> {
    const row = toWalletRow(wallet, this.userId);
    await this.tx
      .update(wallets)
      .set({
        name: row.name,
        description: row.description,
        goal: row.goal,
        color: row.color,
        targetMode: row.targetMode,
        updatedAt: row.updatedAt,
      })
      .where(eq(wallets.id, wallet.id));
  }

  async delete(id: WalletId): Promise<void> {
    // ON DELETE CASCADE on wallet_allocations/wallet_asset_rules (0007_wallets.sql)
    // is a second, defence-in-depth mechanism — the use case
    // (core/wallets/delete-wallet.ts) already clears both explicitly first, so
    // this cascade should find nothing left to do in the normal path.
    await this.tx.delete(wallets).where(eq(wallets.id, id));
  }
}

/**
 * BR-010-05 — the sum invariant. See `core/wallets/ports.ts`'s extended note
 * on `WalletAllocationRepository` and `src/db/schema/wallets.ts` for why this
 * cannot be a database CHECK constraint.
 *
 * `lockForAsset` is the only read this class offers that a write path may
 * legally act on — it runs `SELECT ... FOR UPDATE`, which takes a row lock on
 * every existing allocation for the asset for the lifetime of the caller's
 * transaction. A second `withTenant` transaction attempting the same lock
 * blocks until the first commits or rolls back, so two concurrent
 * allocations against the same asset serialise instead of both reading a
 * total that is stale by the time either writes.
 */
export class DrizzleWalletAllocationRepository implements WalletAllocationRepository {
  constructor(
    private readonly tx: Tx,
    private readonly userId: UserId,
  ) {}

  async listForAsset(assetId: AssetId): Promise<readonly WalletAllocation[]> {
    const rows = await this.tx
      .select()
      .from(walletAllocations)
      .where(eq(walletAllocations.assetId, assetId));
    return rows.map(toAllocationDomain);
  }

  async listForWallet(walletId: WalletId): Promise<readonly WalletAllocation[]> {
    const rows = await this.tx
      .select()
      .from(walletAllocations)
      .where(eq(walletAllocations.walletId, walletId));
    return rows.map(toAllocationDomain);
  }

  async listAll(): Promise<readonly WalletAllocation[]> {
    const rows = await this.tx.select().from(walletAllocations);
    return rows.map(toAllocationDomain);
  }

  async lockForAsset(assetId: AssetId): Promise<readonly WalletAllocation[]> {
    /**
     * `SELECT ... FOR UPDATE` only locks rows that already exist — a phantom
     * gap for the **very first** allocation of an asset, where
     * `wallet_allocations` has no rows yet: two concurrent first-time
     * allocations would find nothing to lock and would not block each
     * other, each computing "nothing else allocated yet" and both writing,
     * jointly exceeding held quantity even though neither individually did.
     *
     * Closed by also locking the asset's `positions` row(s) first. A
     * position row exists whenever the asset is held at all — SPEC-007
     * keeps it even for a fully closed-to-zero position rather than
     * deleting it (`core/positions/replay.ts`) — so it is present in
     * exactly the cases where a race would matter (nothing to allocate
     * means nothing to race over). The first transaction to reach here
     * holds that row's lock for the rest of its transaction; a second
     * concurrent caller blocks on this line until the first commits or
     * rolls back, and only then proceeds to read `wallet_allocations` —
     * by which point it sees whatever the first one wrote.
     */
    await this.tx.select().from(positions).where(eq(positions.assetId, assetId)).for('update');

    // RLS still applies to a locking read — the policy's `USING` clause is
    // evaluated before the lock is taken, so this can never lock (or even
    // see) another tenant's rows. Unqualified on `user_id` for the same
    // reason every other repository in this codebase leaves it out: the
    // policy is what protects the boundary, not a redundant WHERE clause.
    const rows = await this.tx
      .select()
      .from(walletAllocations)
      .where(eq(walletAllocations.assetId, assetId))
      .for('update');
    return rows.map(toAllocationDomain);
  }

  /**
   * SPEC-014 BR-014-12 — the allocation and its history are written together,
   * in the caller's transaction.
   *
   * Appending here rather than at each use case is deliberate: this is the one
   * place every allocation change passes through — an auto-increment on a buy,
   * a proportional reduction on a sale, a corporate-event scaling, a manual
   * assignment. A caller cannot forget to record an event, because recording
   * one is not something the caller does.
   *
   * Both statements run inside the same `withTenant` transaction (AR-11), so
   * the state and the log cannot diverge: either both land or neither does.
   */
  async upsert(allocation: WalletAllocation, change: AllocationChange): Promise<void> {
    const row = toAllocationRow(allocation, this.userId);
    await this.tx
      .insert(walletAllocations)
      .values(row)
      .onConflictDoUpdate({
        target: [walletAllocations.userId, walletAllocations.walletId, walletAllocations.assetId],
        set: {
          quantity: row.quantity,
          costBasisAtAllocation: row.costBasisAtAllocation,
          allocatedAt: row.allocatedAt,
          updatedAt: new Date(),
        },
      });

    await this.recordEvent(
      allocation.walletId,
      allocation.assetId,
      allocation.quantity,
      allocation.costBasisAtAllocation,
      change,
    );
  }

  async delete(walletId: WalletId, assetId: AssetId, change: AllocationChange): Promise<void> {
    await this.tx
      .delete(walletAllocations)
      .where(and(eq(walletAllocations.walletId, walletId), eq(walletAllocations.assetId, assetId)));

    // Zero, not silence. The fold reads the latest event at or before a date;
    // with no row the last positive quantity would stand for every later date,
    // and a sold-out position would keep earning income it never received.
    // SPEC-019 BR-019-11: the invested-basis line needs the same treatment —
    // a removed allocation has zero cost after it, not an unknown one.
    await this.recordEvent(walletId, assetId, Quantity.zero(), Money.zero(), change);
  }

  async deleteForWallet(walletId: WalletId, change: AllocationChange): Promise<void> {
    // Read before delete: the log needs one zero per asset the wallet held,
    // and after the DELETE there is nothing left to enumerate. Same
    // transaction, so no other writer can slip between the two.
    const held = await this.tx
      .select({ assetId: walletAllocations.assetId })
      .from(walletAllocations)
      .where(eq(walletAllocations.walletId, walletId));

    await this.tx.delete(walletAllocations).where(eq(walletAllocations.walletId, walletId));

    for (const row of held) {
      await this.recordEvent(
        walletId,
        AssetId.of(row.assetId),
        Quantity.zero(),
        Money.zero(),
        change,
      );
    }
  }

  /**
   * One row per change, carrying the quantity **after** it. A log of states
   * rather than of deltas: the fold that answers "what did this wallet hold on
   * that date" is then a last-value-per-key lookup with no arithmetic, and a
   * missed row costs one answer rather than every later one.
   *
   * SPEC-019 BR-019-11: `costBasisAfter` carries the same "after" semantics
   * as `quantity`, added by the same migration that introduced `wallet_goals`
   * (`0014_wallet_goals.sql`). It is `Money | null` rather than a required
   * argument because rows written before that migration have no value here —
   * see the column's comment in `src/db/schema/wallets.ts` for why that is
   * expand/contract-safe and deliberately left unbackfilled.
   */
  private async recordEvent(
    walletId: WalletId,
    assetId: AssetId,
    quantity: Quantity,
    costBasisAfter: Money | null,
    change: AllocationChange,
  ): Promise<void> {
    await this.tx.insert(walletAllocationEvents).values({
      id: uuidv7(),
      userId: this.userId,
      walletId,
      assetId,
      quantity,
      costBasisAfter,
      effectiveOn: change.effectiveOn,
      cause: change.cause,
    });
  }
}

export class DrizzleWalletAssetRuleRepository implements WalletAssetRuleRepository {
  constructor(
    private readonly tx: Tx,
    private readonly userId: UserId,
  ) {}

  async find(assetId: AssetId): Promise<WalletId | null> {
    const [row] = await this.tx
      .select()
      .from(walletAssetRules)
      .where(eq(walletAssetRules.assetId, assetId));
    return row ? WalletId.of(row.walletId) : null;
  }

  async list(): Promise<readonly StandingRule[]> {
    const rows = await this.tx.select().from(walletAssetRules);
    return rows.map((row) => ({
      assetId: AssetId.of(row.assetId),
      walletId: WalletId.of(row.walletId),
    }));
  }

  async set(assetId: AssetId, walletId: WalletId): Promise<void> {
    await this.tx
      .insert(walletAssetRules)
      .values({ userId: this.userId, assetId, walletId })
      .onConflictDoUpdate({
        target: [walletAssetRules.userId, walletAssetRules.assetId],
        set: { walletId },
      });
  }

  async clear(assetId: AssetId): Promise<void> {
    await this.tx.delete(walletAssetRules).where(eq(walletAssetRules.assetId, assetId));
  }

  async clearForWallet(walletId: WalletId): Promise<void> {
    await this.tx.delete(walletAssetRules).where(eq(walletAssetRules.walletId, walletId));
  }
}

/**
 * SPEC-017 — the target set's persistence, and the 100 % invariant's lock.
 *
 * See `core/wallets/ports.ts`'s note on `WalletTargetRepository` for why the
 * lock is taken on the **wallet** row rather than on the target rows, and
 * `src/db/schema/wallets.ts` for why no CHECK constraint can hold the
 * invariant in the first place.
 */
export class DrizzleWalletTargetRepository implements WalletTargetRepository {
  constructor(
    private readonly tx: Tx,
    private readonly userId: UserId,
  ) {}

  async listForWallet(walletId: WalletId): Promise<readonly StoredWalletTarget[]> {
    const rows = await this.tx
      .select()
      .from(walletTargets)
      .where(eq(walletTargets.walletId, walletId));
    return rows.map(toTargetDomain);
  }

  async listAll(): Promise<readonly StoredWalletTarget[]> {
    const rows = await this.tx.select().from(walletTargets);
    return rows.map(toTargetDomain);
  }

  async lockForWallet(walletId: WalletId): Promise<readonly StoredWalletTarget[]> {
    /**
     * The wallet row, locked first and for the rest of the transaction. Every
     * writer of this wallet's targets passes through here, so two concurrent
     * edits serialise on this line rather than both reading a set that is
     * stale by the time either writes.
     *
     * RLS still applies to a locking read — the policy's `USING` clause is
     * evaluated before the lock is taken — so this can never lock, or even
     * see, another tenant's wallet.
     */
    await this.tx.select().from(wallets).where(eq(wallets.id, walletId)).for('update');

    const rows = await this.tx
      .select()
      .from(walletTargets)
      .where(eq(walletTargets.walletId, walletId))
      .for('update');
    return rows.map(toTargetDomain);
  }

  /**
   * Delete-then-insert inside the caller's transaction (AR-11), so the table
   * never holds a partially applied set. An upsert per row would leave a
   * window in which the stored percentages total something other than 100 —
   * the exact state BR-017-04 says may not be persisted.
   */
  async replaceForWallet(
    walletId: WalletId,
    targets: readonly StoredWalletTarget[],
  ): Promise<void> {
    await this.tx.delete(walletTargets).where(eq(walletTargets.walletId, walletId));
    if (targets.length === 0) return;

    await this.tx.insert(walletTargets).values(
      targets.map((target) => ({
        // AR-25: UUIDv7, time-ordered — the set is rewritten wholesale, so
        // every row here is a genuine insert.
        id: uuidv7(),
        userId: this.userId,
        walletId,
        assetId: target.assetId,
        targetPct: target.targetPct,
      })),
    );
  }
}

function toTargetDomain(row: typeof walletTargets.$inferSelect): StoredWalletTarget {
  return {
    walletId: WalletId.of(row.walletId),
    assetId: AssetId.of(row.assetId),
    targetPct: row.targetPct,
  };
}

/**
 * AR-02/AR-03: the seam between wallets and SPEC-007's position cache.
 * Reads `positions` (never the ledger) and aggregates across institutions
 * with the same function SPEC-007's own reports use, so a wallet's notion of
 * "held quantity" can never disagree with the Composition report's.
 */
export class DrizzlePositionQueryRepository implements PositionQueryPort {
  constructor(private readonly tx: Tx) {}

  async query(assetId: AssetId): Promise<AssetPositionQuery> {
    const rows = await this.tx.select().from(positions).where(eq(positions.assetId, assetId));
    const [aggregate] = aggregateAcrossInstitutions(rows.map(toSnapshot));
    return {
      assetId,
      quantity: aggregate?.state.quantity ?? Quantity.zero(),
      averageCost: aggregate?.state.averageCost ?? Money.zero(),
    };
  }

  async listHeld(): Promise<readonly AssetPositionQuery[]> {
    const rows = await this.tx.select().from(positions);
    // `aggregateAcrossInstitutions` already groups by asset and drops
    // nothing — reused directly rather than re-grouping by hand, so a
    // wallet's notion of "every held asset" cannot diverge from the
    // Composition report's.
    return aggregateAcrossInstitutions(rows.map(toSnapshot))
      .filter((position) => position.state.quantity.isPositive())
      .map((position) => ({
        assetId: position.assetId,
        quantity: position.state.quantity,
        averageCost: position.state.averageCost,
      }));
  }
}

function toSnapshot(row: typeof positions.$inferSelect): PositionSnapshot {
  return {
    assetId: AssetId.of(row.assetId),
    institutionId: row.institutionId === null ? null : InstitutionId.of(row.institutionId),
    state: {
      quantity: row.quantity,
      totalCost: row.totalCost,
      averageCost: row.averageCost,
      realizedGain: row.realizedGain,
    },
  };
}

function toWalletDomain(row: typeof wallets.$inferSelect): Wallet {
  return {
    id: WalletId.of(row.id),
    userId: row.userId as UserId,
    name: row.name,
    description: row.description,
    goal: row.goal,
    color: row.color,
    targetMode: toTargetMode(row.targetMode),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The column is `text` with a CHECK (AR-30), so the driver hands back a plain
 * string. The CHECK makes an unknown value unreachable through this
 * application; falling back to `'none'` rather than throwing keeps a wallet
 * readable if one ever arrives from a hand-run statement — with **no** targets
 * applied, which is the only safe reading of a mode nobody understands.
 */
function toTargetMode(value: string): TargetMode {
  return isTargetMode(value) ? value : 'none';
}

function toWalletRow(wallet: Wallet, userId: UserId): typeof wallets.$inferInsert {
  return {
    id: wallet.id,
    userId,
    name: wallet.name,
    description: wallet.description,
    goal: wallet.goal,
    color: wallet.color,
    targetMode: wallet.targetMode,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

function toAllocationDomain(row: typeof walletAllocations.$inferSelect): WalletAllocation {
  return {
    userId: row.userId as UserId,
    walletId: WalletId.of(row.walletId),
    assetId: AssetId.of(row.assetId),
    quantity: row.quantity,
    costBasisAtAllocation: row.costBasisAtAllocation,
    allocatedAt: row.allocatedAt,
  };
}

function toAllocationRow(
  allocation: WalletAllocation,
  userId: UserId,
): typeof walletAllocations.$inferInsert {
  return {
    // AR-25: UUIDv7, time-ordered. `onConflictDoUpdate` below never SETs this
    // column, so on an existing `(user, wallet, asset)` row Postgres keeps
    // the id the row already had — this value is only ever used by a genuine
    // insert.
    id: uuidv7(),
    userId,
    walletId: allocation.walletId,
    assetId: allocation.assetId,
    quantity: allocation.quantity,
    costBasisAtAllocation: allocation.costBasisAtAllocation,
    allocatedAt: allocation.allocatedAt,
  };
}
