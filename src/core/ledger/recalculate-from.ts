import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, InstitutionId } from '@/core/shared/ids';
import { type Result, ok } from '@/core/shared/result';
import type { PositionSnapshot } from '@/core/positions/replay';
import { replayPosition } from '@/core/positions/replay';
import type { LedgerDependencies } from '@/core/ledger/dependencies';

/**
 * SPEC-006 BR-006-14 / BR-006-18, DL-006-03 — recalculation after a write.
 *
 * **Why the position is recomputed from the beginning, not "from the date".**
 * A moving weighted average is path-dependent from the very first acquisition:
 * to resume at a date you would need the state *at* that date, and obtaining
 * that state is the replay. There is nothing cheaper to resume from.
 *
 * DL-006-03's "forward from the transaction date, not from today" is a
 * statement about **which derived artefacts must be invalidated** — SPEC-009's
 * daily valuation snapshots from that date onwards, and the report figures
 * built on them — not about how a position is computed. Recalculating only
 * current state is the mistake it forbids, because it leaves historical charts
 * silently disagreeing with the transactions behind them.
 *
 * So `fromDate` is carried on the result rather than used here: it is the
 * boundary SPEC-009 will invalidate from once daily snapshots exist. Today
 * nothing consumes it, and the alternative — discovering later that the
 * boundary was never recorded — costs a second pass over every write path.
 */
export interface RecalculationScope {
  readonly assetId: AssetId;
  readonly institutionId: InstitutionId | null;
  /** The earliest date whose derived figures are now stale (DL-006-03). */
  readonly fromDate: BusinessDate;
}

export interface RecalculationOutcome {
  readonly scope: RecalculationScope;
  /**
   * The recomputed position, or `null` when the last transaction for this
   * `(asset, institution)` has just been deleted and the cached row was
   * removed. A stored position with no ledger behind it would contradict a
   * rebuild (DM-4) the moment anyone checked.
   */
  readonly position: PositionSnapshot | null;
}

/**
 * Replays one `(asset, institution)` position from the ledger and writes the
 * result into the position cache.
 *
 * The ledger is re-read here rather than reusing the candidate list the
 * calling use case already validated against. That costs one query and buys
 * the property that matters: what lands in the cache is a replay of what is
 * *actually stored*, not a replay of what the use case believed it was about
 * to store.
 */
export async function recalculatePositionFrom(
  deps: LedgerDependencies,
  scope: RecalculationScope,
): Promise<Result<RecalculationOutcome, DomainError>> {
  const transactions = await deps.transactions.listForPosition(scope.assetId, scope.institutionId);

  if (transactions.length === 0) {
    await deps.positions.deleteMany([
      { assetId: scope.assetId, institutionId: scope.institutionId },
    ]);
    return ok({ scope, position: null });
  }

  const replayed = replayPosition(transactions);
  if (!replayed.ok) return replayed;

  const position: PositionSnapshot = {
    assetId: scope.assetId,
    institutionId: scope.institutionId,
    state: replayed.value,
  };
  await deps.positions.upsertMany([position]);
  return ok({ scope, position });
}
