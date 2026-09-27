import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, InstitutionId, TransactionId } from '@/core/shared/ids';
import { type Result, err, ok } from '@/core/shared/result';
import { replayPositionWithEstimate } from '@/core/positions/replay';
import type { PositionState } from '@/core/positions/position-state';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import { LedgerErrorCode, ledgerError } from '@/core/ledger/errors';
import {
  guardCarriedLegs,
  planCarriedLegUpdates,
  recalculateCarriedPositions,
} from '@/core/ledger/carried-legs';
import { without } from '@/core/ledger/guard-replayable';
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
  /**
   * SPEC-007 BR-007-06 (amended 2026-09-21) / DL-007-12 — whether the
   * position, before and after the deletion, carries an estimated cost.
   * Folded by `replayPositionWithEstimate`, the same fold every position
   * writer uses, rather than decided here: a page showing "before" and
   * "after" figures that disagreed with the position cache about which one
   * is an estimate would be worse than showing neither.
   */
  readonly currentCostEstimated: boolean;
  readonly projectedCostEstimated: boolean;
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

  const current = replayPositionWithEstimate(existing);
  if (!current.ok) return current;

  const remaining = without(existing, new Set([target.id]));
  const projected = replayPositionWithEstimate(remaining);
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
    currentPosition: current.value.state,
    projectedPosition: projected.value.state,
    currentCostEstimated: current.value.costEstimated,
    projectedCostEstimated: projected.value.costEstimated,
  });
}

export interface DeleteTransactionResult {
  readonly deletedCount: number;
  readonly recalculation: RecalculationOutcome;
  /**
   * SPEC-007 BR-007-06 (#144 F6): the carried legs downstream of the deleted
   * row's position, re-derived without it, and a recalculation for every
   * position they sit in.
   */
  readonly rederived: readonly Transaction[];
  readonly downstream: readonly RecalculationOutcome[];
}

export async function deleteTransaction(
  deps: LedgerDependencies,
  id: TransactionId,
): Promise<Result<DeleteTransactionResult, DomainError>> {
  const target = await deps.transactions.findById(id);
  if (target === null) {
    return err(ledgerError(LedgerErrorCode.TRANSACTION_NOT_FOUND, { transactionId: id }));
  }

  // SPEC-007 BR-007-06 (#144 F6): deleting an estimated row at A re-derives
  // what A carried on, exactly as correcting its price does. Planned first so
  // BR-006-15's guard sees A — and everything downstream — with the
  // re-derived legs in place, as the edit path does (#144 re-review N1).
  const removed = new Set<string>([target.id]);
  const rederived = await planCarriedLegUpdates(deps, [target], (ledger) =>
    without(ledger, removed),
  );
  const guard = await guardCarriedLegs(deps, rederived, removed, [target]);
  if (!guard.ok) return guard;

  const deletedCount = await deps.transactions.deleteByIds([target.id]);
  for (const leg of rederived) await deps.transactions.update(leg);

  const recalculation = await recalculatePositionFrom(deps, {
    assetId: target.assetId,
    institutionId: target.institutionId,
    fromDate: target.tradeDate,
  });
  if (!recalculation.ok) return recalculation;

  const downstream = await recalculateCarriedPositions(deps, rederived, [target]);
  if (!downstream.ok) return downstream;

  return ok({
    deletedCount,
    recalculation: recalculation.value,
    rederived,
    downstream: downstream.value,
  });
}

function countOnOrAfter(transactions: readonly Transaction[], date: BusinessDate): number {
  return transactions.filter((transaction) => transaction.tradeDate >= date).length;
}
