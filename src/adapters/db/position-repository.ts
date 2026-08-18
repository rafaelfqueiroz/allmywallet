import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { chunked } from '@/adapters/db/chunk';
import type { SQL } from 'drizzle-orm';
import { AssetId, InstitutionId, PositionId, type UserId } from '@/core/shared/ids';
import { makePosition } from '@/core/positions/position-state';
import type { PositionRepository } from '@/core/positions/ports';
import type { PositionKey, PositionSnapshot } from '@/core/positions/replay';
import { positions } from '@/db/schema/positions';
import type { Tx } from '@/db/tenant';

/**
 * SPEC-007's position cache.
 *
 * AR-11: runs on a `withTenant` transaction; RLS supplies the tenant filter on
 * reads and `WITH CHECK` verifies it on writes, which is why `user_id` is
 * written explicitly and never read back into a WHERE clause.
 *
 * Nothing here adds to or subtracts from a stored figure. Positions are
 * derived (DL-006-01), so every write is a whole replayed value overwriting
 * whatever was there. An `UPDATE … SET quantity = quantity + $1` would be a
 * second, unreviewable implementation of the average-cost rules living in SQL.
 */
export class DrizzlePositionRepository implements PositionRepository {
  constructor(
    private readonly tx: Tx,
    private readonly userId: UserId,
  ) {}

  async list(): Promise<readonly PositionSnapshot[]> {
    const rows = await this.tx.select().from(positions);
    return rows.map(toDomain);
  }

  async upsertMany(snapshots: readonly PositionSnapshot[]): Promise<void> {
    if (snapshots.length === 0) return;
    for (const snapshot of snapshots) {
      await this.tx
        .insert(positions)
        .values(toRow(snapshot, this.userId))
        .onConflictDoUpdate({
          // Matches `positions_user_asset_institution_key`, which is declared
          // NULLS NOT DISTINCT — without that, a holding with no institution
          // would conflict with nothing and insert a duplicate row on every
          // single recalculation.
          target: [positions.userId, positions.assetId, positions.institutionId],
          set: {
            quantity: snapshot.state.quantity,
            averageCost: snapshot.state.averageCost,
            totalCost: snapshot.state.totalCost,
            realizedGain: snapshot.state.realizedGain,
            updatedAt: new Date(),
          },
        });
    }
  }

  async deleteMany(keys: readonly PositionKey[]): Promise<void> {
    if (keys.length === 0) return;
    const clauses = keys.map(matchKey);
    const predicate = clauses.length === 1 ? clauses[0] : or(...clauses);
    if (predicate === undefined) return;
    await this.tx.delete(positions).where(predicate);
  }

  async replaceAll(snapshots: readonly PositionSnapshot[]): Promise<void> {
    /**
     * DM-4 / BR-007-14: the full rebuild, and it must be **atomic**. Both
     * statements run inside the caller's `withTenant` transaction, so a crash
     * between them rolls back rather than leaving the tenant with no positions
     * at all. The DELETE is unqualified on purpose — RLS scopes it to this
     * tenant, and adding a redundant `user_id` filter would imply the filter
     * is what protects other tenants' rows when in fact the policy is.
     */
    await this.tx.delete(positions);
    if (snapshots.length === 0) return;
    // Chunked for the same reason as `import-row-repository.ts`: a tenant with
    // enough (asset, institution) pairs would otherwise overflow the builder
    // on the one path that exists to repair them (`pnpm positions:rebuild`).
    for (const chunk of chunked(snapshots)) {
      await this.tx.insert(positions).values(chunk.map((s) => toRow(s, this.userId)));
    }
  }
}

function matchKey(key: PositionKey): SQL {
  const clause = and(
    eq(positions.assetId, key.assetId),
    key.institutionId === null
      ? isNull(positions.institutionId)
      : eq(positions.institutionId, key.institutionId),
  );
  // `and()` of two present clauses is always defined; the cast documents that
  // rather than adding an unreachable branch for coverage to chase.
  return clause ?? sql`false`;
}

function toRow(snapshot: PositionSnapshot, userId: UserId): typeof positions.$inferInsert {
  return {
    id: PositionId.generate(),
    userId,
    assetId: snapshot.assetId,
    institutionId: snapshot.institutionId,
    quantity: snapshot.state.quantity,
    averageCost: snapshot.state.averageCost,
    totalCost: snapshot.state.totalCost,
    realizedGain: snapshot.state.realizedGain,
  };
}

function toDomain(row: typeof positions.$inferSelect): PositionSnapshot {
  return {
    assetId: AssetId.of(row.assetId),
    institutionId: row.institutionId === null ? null : InstitutionId.of(row.institutionId),
    // Rebuilt through `makePosition` rather than assembled as a literal, so a
    // row that somehow violated BR-007-07 (quantity zero with residual cost)
    // is normalised on read to the same state a replay would produce — the
    // cache can then never disagree with the ledger about a closed position.
    state: makePosition(row.quantity, row.totalCost, row.realizedGain, row.averageCost),
  };
}
