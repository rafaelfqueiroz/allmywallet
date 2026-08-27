import { and, eq, isNull } from 'drizzle-orm';
import type { BusinessDate } from '@/core/shared/clock';
import type { UserId, WalletId } from '@/core/shared/ids';
import { WalletGoalId } from '@/core/shared/ids';
import type { GoalKind, GrowthBasis, EarningsPeriod, WalletGoal } from '@/core/goals/goal';
import type { WalletGoalRepository } from '@/core/goals/ports';
import { walletGoals } from '@/db/schema/goals';
import type { Tx } from '@/db/tenant';

/**
 * SPEC-019's persistence, in the shape of `DrizzleWalletRepository`
 * (`src/adapters/db/wallet-repository.ts`): AR-11 — every method runs on a
 * `Tx` obtained from `withTenant`; RLS supplies the tenant filter on reads and
 * `WITH CHECK` verifies it on writes, so `user_id` is written explicitly on
 * every insert but never added redundantly to a WHERE clause.
 */
export class DrizzleWalletGoalRepository implements WalletGoalRepository {
  constructor(
    private readonly tx: Tx,
    private readonly userId: UserId,
  ) {}

  async findById(id: WalletGoalId): Promise<WalletGoal | null> {
    const [row] = await this.tx.select().from(walletGoals).where(eq(walletGoals.id, id));
    return row ? toGoalDomain(row) : null;
  }

  async listForWallet(walletId: WalletId): Promise<readonly WalletGoal[]> {
    const rows = await this.tx.select().from(walletGoals).where(eq(walletGoals.walletId, walletId));
    return rows.map(toGoalDomain);
  }

  async listAll(): Promise<readonly WalletGoal[]> {
    const rows = await this.tx.select().from(walletGoals);
    return rows.map(toGoalDomain);
  }

  async insert(goal: WalletGoal): Promise<void> {
    await this.tx.insert(walletGoals).values(toGoalRow(goal, this.userId));
  }

  async update(goal: WalletGoal): Promise<void> {
    const row = toGoalRow(goal, this.userId);
    await this.tx
      .update(walletGoals)
      .set({
        name: row.name,
        kind: row.kind,
        amount: row.amount,
        basis: row.basis,
        period: row.period,
        // AR-29: the `date` column comes back as `YYYY-MM-DD`, which is exactly
        // what a `BusinessDate` is — branded here, at the one boundary that reads it.
        achievedOn: (row.achievedOn as BusinessDate | null) ?? null,
        updatedAt: row.updatedAt,
      })
      .where(eq(walletGoals.id, goal.id));
  }

  async delete(id: WalletGoalId): Promise<void> {
    await this.tx.delete(walletGoals).where(eq(walletGoals.id, id));
  }

  /**
   * BR-019-24/26 — idempotent at the SQL level, not by caller discipline.
   * `WHERE achieved_on IS NULL` means a goal that already carries a date
   * matches zero rows here and the `UPDATE` is a no-op, so a re-evaluation
   * racing a previous one — or simply running twice — can never move the
   * recorded date forward, or clear it and set a different one.
   */
  async markAchieved(id: WalletGoalId, achievedOn: BusinessDate): Promise<boolean> {
    // `returning` is what lets the caller tell "I marked it" from "somebody
    // else already had". Without it the UPDATE is silent about matching zero
    // rows, and BR-019-25's one email becomes two under two overlapping
    // renders — see the port's own note on READ COMMITTED.
    const written = await this.tx
      .update(walletGoals)
      .set({ achievedOn, updatedAt: new Date() })
      .where(and(eq(walletGoals.id, id), isNull(walletGoals.achievedOn)))
      .returning({ id: walletGoals.id });
    return written.length > 0;
  }
}

function toGoalDomain(row: typeof walletGoals.$inferSelect): WalletGoal {
  return {
    id: WalletGoalId.of(row.id),
    userId: row.userId as UserId,
    walletId: row.walletId as WalletId,
    name: row.name,
    kind: row.kind as GoalKind,
    amount: row.amount,
    basis: row.basis as GrowthBasis | null,
    period: row.period as EarningsPeriod | null,
    // AR-29: the `date` column comes back as `YYYY-MM-DD`, which is exactly
    // what a `BusinessDate` is — branded here, at the one boundary that reads it.
    achievedOn: (row.achievedOn as BusinessDate | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toGoalRow(goal: WalletGoal, userId: UserId): typeof walletGoals.$inferInsert {
  return {
    id: goal.id,
    userId,
    walletId: goal.walletId,
    name: goal.name,
    kind: goal.kind,
    amount: goal.amount,
    basis: goal.basis,
    period: goal.period,
    achievedOn: goal.achievedOn,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}
