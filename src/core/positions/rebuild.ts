import type { DomainError } from '@/core/shared/domain-error';
import { type Result, ok } from '@/core/shared/result';
import type { TransactionRepository } from '@/core/ledger/ports';
import type { PositionRepository } from '@/core/positions/ports';
import { type PositionSnapshot, replayPositions } from '@/core/positions/replay';

/**
 * SPEC-007 BR-007-14 / DM-4 — the full rebuild, and DL-007-06's reason for it:
 * the incremental path is where subtle ordering bugs live, and they are
 * invisible until someone reconciles against a broker statement. Asserting
 * that a rebuild and the incrementally-maintained cache agree turns a class of
 * silent corruption into a failing test (TS-08).
 *
 * It is also the repair mechanism DL-006-01 buys: because positions are
 * derived and rebuildable, a calculation bug is fixed by correcting the logic
 * and replaying. There is no corrupted state to migrate.
 */

export interface RebuildDependencies {
  readonly transactions: TransactionRepository;
  readonly positions: PositionRepository;
}

/**
 * Replays the entire ledger and replaces the position cache with the result.
 *
 * Nothing is written when the replay fails. A ledger that cannot be replayed —
 * a sale of more than was held at that date — must not half-overwrite the
 * cache with the positions that happened to succeed, because the surviving
 * mixture would be neither the old figures nor the new ones and nothing would
 * say so.
 */
export async function rebuildPositions(
  deps: RebuildDependencies,
): Promise<Result<readonly PositionSnapshot[], DomainError>> {
  const transactions = await deps.transactions.listAll();
  const replayed = replayPositions(transactions);
  if (!replayed.ok) return replayed;

  await deps.positions.replaceAll(replayed.value);
  return ok(replayed.value);
}
