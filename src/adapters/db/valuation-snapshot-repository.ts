import { and, asc, gte, lte } from 'drizzle-orm';
import { BusinessDate } from '@/core/shared/clock';
import type { UserId } from '@/core/shared/ids';
import { deserializeAssetClassBreakdown, serializeSnapshot } from '@/core/valuation/snapshot';
import type { DailyValuationSnapshot, SnapshotRepositoryPort } from '@/core/valuation/ports';
import { dailyValuationSnapshots } from '@/db/schema/valuation';
import type { Tx } from '@/db/tenant';

/**
 * SPEC-009 BR-009-16..18 — the snapshot cache.
 *
 * AR-11: runs on a `withTenant` transaction; RLS supplies the tenant filter on
 * reads and `WITH CHECK` verifies it on writes, which is why `user_id` is
 * written explicitly and never read back into a WHERE clause.
 *
 * Nothing here adds to or subtracts from a stored figure. Snapshots are
 * derived (BR-009-17), so every write is a whole recomputed value overwriting
 * whatever was there. An `UPDATE … SET total_value = total_value + $1` would
 * be a second, unreviewable implementation of the valuation rules living in
 * SQL — and one that could not be rebuilt from the ledger.
 */
export class DrizzleValuationSnapshotRepository implements SnapshotRepositoryPort {
  constructor(
    private readonly tx: Tx,
    private readonly userId: UserId,
  ) {}

  /**
   * AR-19: keyed `(user_id, date)`, so a retried `valuation.snapshot` job
   * overwrites the day it already wrote rather than appending a second row —
   * which would double every total that summed this table.
   */
  async upsertMany(snapshots: readonly DailyValuationSnapshot[]): Promise<void> {
    if (snapshots.length === 0) return;
    for (const snapshot of snapshots) {
      // AR-10: every figure crosses as a plain decimal string. `by_asset_class`
      // is jsonb and a `Decimal` reaching `JSON.stringify` comes back a float.
      const serialized = serializeSnapshot(snapshot);
      await this.tx
        .insert(dailyValuationSnapshots)
        .values({
          userId: this.userId,
          date: serialized.date,
          totalValue: snapshot.totalValue,
          netContributions: snapshot.netContributions,
          earningsToDate: snapshot.earningsToDate,
          byAssetClass: serialized.byAssetClass,
          hasEstimates: snapshot.hasEstimates,
        })
        .onConflictDoUpdate({
          target: [dailyValuationSnapshots.userId, dailyValuationSnapshots.date],
          set: {
            totalValue: snapshot.totalValue,
            netContributions: snapshot.netContributions,
            earningsToDate: snapshot.earningsToDate,
            byAssetClass: serialized.byAssetClass,
            hasEstimates: snapshot.hasEstimates,
            updatedAt: new Date(),
          },
        });
    }
  }

  /**
   * BR-009-18 / AC-15 — invalidation. A backdated or edited transaction makes
   * every snapshot from its trade date forward wrong, so they are dropped
   * rather than left to be silently overwritten one by one: a range that has
   * shrunk (every transaction in a period deleted) must not leave orphaned
   * rows claiming a value with no ledger under it.
   *
   * The DELETE is unqualified on `user_id` on purpose — RLS scopes it to this
   * tenant, and adding a redundant filter would imply the filter is what
   * protects other tenants' rows when in fact the policy is.
   */
  async deleteFrom(date: BusinessDate): Promise<number> {
    const removed = await this.tx
      .delete(dailyValuationSnapshots)
      .where(gte(dailyValuationSnapshots.date, date))
      .returning({ date: dailyValuationSnapshots.date });
    return removed.length;
  }

  async listRange(
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<readonly DailyValuationSnapshot[]> {
    const rows = await this.tx
      .select()
      .from(dailyValuationSnapshots)
      .where(and(gte(dailyValuationSnapshots.date, from), lte(dailyValuationSnapshots.date, to)))
      .orderBy(asc(dailyValuationSnapshots.date));
    return rows.map(toDomain);
  }
}

// AR-06/AR-07: the `money` custom type already parses NUMERIC -> Money at the
// driver boundary, so the three figures below are already `Money`. Only
// `by_asset_class` needs converting, because jsonb hands back plain strings.
function toDomain(row: typeof dailyValuationSnapshots.$inferSelect): DailyValuationSnapshot {
  return {
    date: BusinessDate.of(row.date),
    totalValue: row.totalValue,
    netContributions: row.netContributions,
    earningsToDate: row.earningsToDate,
    byAssetClass: deserializeAssetClassBreakdown(row.byAssetClass),
    hasEstimates: row.hasEstimates,
  };
}
