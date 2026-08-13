import type { PositionKey, PositionSnapshot } from '@/core/positions/replay';

/**
 * AR-02: declared here, implemented in `adapters/db/position-repository.ts`.
 *
 * `positions` is a **cache**, not a source of truth (BR-006-01, DL-006-01):
 * every row in it is reproducible from the ledger, and if the two disagree the
 * ledger wins. That is why this port has no "adjust by" operation — nothing
 * ever nudges a stored position; it is always overwritten with a replayed one.
 */
export interface PositionRepository {
  list(): Promise<readonly PositionSnapshot[]>;

  /**
   * The incremental path: overwrite exactly the positions named, leaving the
   * rest alone. Used after a single transaction is created, edited or deleted
   * (BR-006-14).
   */
  upsertMany(snapshots: readonly PositionSnapshot[]): Promise<void>;

  /**
   * Removes stored positions whose last transaction has just been deleted, so
   * a position with no ledger behind it cannot linger in the cache and
   * silently contradict a rebuild (DM-4).
   */
  deleteMany(keys: readonly PositionKey[]): Promise<void>;

  /**
   * DM-4 / BR-007-14: the full rebuild. Replaces the entire cache for this
   * tenant atomically, so a rebuild interrupted halfway cannot leave a mix of
   * old and new figures.
   */
  replaceAll(snapshots: readonly PositionSnapshot[]): Promise<void>;
}
