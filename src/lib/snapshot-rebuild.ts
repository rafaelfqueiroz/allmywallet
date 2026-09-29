import type { BusinessDate } from '@/core/shared/clock';
import type { UserId } from '@/core/shared/ids';
import { logger } from '@/lib/logger';
import { enqueue } from '@/lib/queue';
import { QUEUE } from '@/worker/queues';

/**
 * SPEC-009 BR-009-18 / SPEC-006 BR-006-14 — a ledger write that changed
 * derived figures from `from` forward asks the worker to rebuild the daily
 * valuation snapshots for `[from, today]`, the same `valuation.snapshot` job
 * the import commit, the quote sync and the fixed-income contract write already
 * enqueue (AR-16: the web process only enqueues).
 *
 * **Call it after the write's transaction has committed**, never inside
 * `withTenant`, and only on a successful outcome: a rebuild requested for a
 * write that did not happen would just rebuild identical snapshots, and one
 * requested before the commit can run before the ledger it reads exists.
 *
 * **Best effort by design.** A failed enqueue is logged and swallowed. The
 * ledger write already committed; throwing would show an error boundary for a
 * write that succeeded and invite a retry of it. Only the derived cache is
 * behind, and the nightly full rebuild (a `valuation.snapshot` with no payload)
 * covers it (BR-009-17: snapshots are cache, the ledger wins).
 *
 * `null` means the write recalculated nothing, so there is nothing to rebuild.
 *
 * AR-21 / BR-004-04: the payload and the log line carry the tenant's UUID and a
 * `YYYY-MM-DD` date — no figure, no name.
 */
export async function requestSnapshotRebuild(
  userId: UserId,
  from: BusinessDate | null,
): Promise<void> {
  if (from === null) return;
  try {
    await enqueue(QUEUE.VALUATION_SNAPSHOT, { userId, from });
  } catch (error) {
    logger.error(
      { err: error, component: 'snapshot-rebuild', userId, from },
      'SPEC-009 BR-009-18: could not request a snapshot rebuild; the nightly sweep will cover it',
    );
  }
}
