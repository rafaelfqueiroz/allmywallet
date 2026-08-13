import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, InstitutionId, TransactionId } from '@/core/shared/ids';
import { type Result, err, ok } from '@/core/shared/result';
import { replayPosition } from '@/core/positions/replay';
import type { PositionState } from '@/core/positions/position-state';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import { LedgerErrorCode, ledgerError } from '@/core/ledger/errors';
import { guardReplayable, without } from '@/core/ledger/guard-replayable';
import type { Transaction } from '@/core/ledger/transaction';
import { recalculatePositionFrom, type RecalculationOutcome } from '@/core/ledger/recalculate-from';

/**
 * SPEC-006 BR-006-13 / DL-006-04: deletion is permitted, **with the
 * recalculation disclosed beforehand**.
 *
 * Forbidding deletion was considered and rejected: users make genuine
 * mistakes — a duplicate manual entry, the wrong asset — and blocking the
 * obvious fix pushes them into workarounds that corrupt the ledger worse than
 * the original error did.
 */

/**
 * BR-006-13's "confirmation stating what will be recalculated", assembled
 * *before* anything is deleted so the UI can show it and the user can decline.
 *
 * `projectedPosition` is the honest part: it is the actual replayed result of
 * the ledger without this row, not an estimate. Showing "your position will
 * change" without saying what to is the kind of disclosure that satisfies a
 * checklist and nobody reading it.
 */
export interface DeletionImpact {
  readonly transactionId: TransactionId;
  readonly assetId: AssetId;
  readonly institutionId: InstitutionId | null;
  /** DL-006-03: everything derived from this date forward becomes stale. */
  readonly fromDate: BusinessDate;
  /** How many other rows for this position sit on or after that date. */
  readonly subsequentTransactionCount: number;
  readonly currentPosition: PositionState;
  readonly projectedPosition: PositionState;
}

export async function describeDeletionImpact(
  deps: LedgerDependencies,
  id: TransactionId,
): Promise<Result<DeletionImpact, DomainError>> {
  const target = await deps.transactions.findById(id);
  if (target === null) {
    return err(ledgerError(LedgerErrorCode.TRANSACTION_NOT_FOUND, { transactionId: id }));
  }

  const existing = await deps.transactions.listForPosition(target.assetId, target.institutionId);

  const current = replayPosition(existing);
  if (!current.ok) return current;

  const remaining = without(existing, new Set([target.id]));
  const projected = replayPosition(remaining);
  // BR-006-15 again: deleting the buy a later sale drew on leaves a ledger
  // that cannot be replayed. The user is told that here, before confirming,
  // rather than after the row is already gone.
  if (!projected.ok) return projected;

  return ok({
    transactionId: target.id,
    assetId: target.assetId,
    institutionId: target.institutionId,
    fromDate: target.tradeDate,
    subsequentTransactionCount: countOnOrAfter(remaining, target.tradeDate),
    currentPosition: current.value,
    projectedPosition: projected.value,
  });
}

export interface DeleteTransactionResult {
  readonly deletedCount: number;
  readonly recalculation: RecalculationOutcome;
}

export async function deleteTransaction(
  deps: LedgerDependencies,
  id: TransactionId,
): Promise<Result<DeleteTransactionResult, DomainError>> {
  const target = await deps.transactions.findById(id);
  if (target === null) {
    return err(ledgerError(LedgerErrorCode.TRANSACTION_NOT_FOUND, { transactionId: id }));
  }

  const guard = await guardReplayable(deps, target, (existing) =>
    without(existing, new Set([target.id])),
  );
  if (!guard.ok) return guard;

  const deletedCount = await deps.transactions.deleteByIds([target.id]);

  const recalculation = await recalculatePositionFrom(deps, {
    assetId: target.assetId,
    institutionId: target.institutionId,
    fromDate: target.tradeDate,
  });
  if (!recalculation.ok) return recalculation;

  return ok({ deletedCount, recalculation: recalculation.value });
}

function countOnOrAfter(transactions: readonly Transaction[], date: BusinessDate): number {
  return transactions.filter((transaction) => transaction.tradeDate >= date).length;
}
