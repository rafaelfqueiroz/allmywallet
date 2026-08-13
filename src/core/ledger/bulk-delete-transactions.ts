import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { TransactionId } from '@/core/shared/ids';
import { type Result, err, ok } from '@/core/shared/result';
import { positionKeyString, type PositionKey } from '@/core/positions/replay';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import { LedgerErrorCode, ledgerError } from '@/core/ledger/errors';
import { guardReplayable, without } from '@/core/ledger/guard-replayable';
import type { Transaction } from '@/core/ledger/transaction';
import { recalculatePositionFrom, type RecalculationOutcome } from '@/core/ledger/recalculate-from';

/**
 * SPEC-006 BR-006-17: bulk delete over a multi-selection.
 *
 * **All or nothing.** The rows are grouped by position and every affected
 * position is replayed *with the whole selection removed* before anything is
 * deleted. Deleting row by row would let a partially-applied selection leave a
 * ledger that cannot be replayed — and the user would be looking at a
 * half-finished operation with no way to tell which half.
 *
 * Grouping first also matters for correctness, not just for speed: a selection
 * that removes a buy and its later sale together is legal, while removing the
 * buy alone is not. Validating each row in isolation would refuse the whole
 * perfectly ordinary "undo this pair of duplicates" case.
 *
 * Bulk **wallet assignment**, BR-006-17's other half, is not here. The spec
 * itself delegates it to SPEC-010 ("bulk assignment here delegates to it") and
 * wallets do not exist yet — see the report's deviations.
 */

export interface BulkDeleteResult {
  readonly deletedCount: number;
  readonly recalculations: readonly RecalculationOutcome[];
}

export async function bulkDeleteTransactions(
  deps: LedgerDependencies,
  ids: readonly TransactionId[],
): Promise<Result<BulkDeleteResult, DomainError>> {
  if (ids.length === 0) {
    return err(ledgerError(LedgerErrorCode.EMPTY_SELECTION, { operation: 'bulk_delete' }));
  }

  const targets: Transaction[] = [];
  for (const id of ids) {
    const found = await deps.transactions.findById(id);
    if (found === null) {
      return err(ledgerError(LedgerErrorCode.TRANSACTION_NOT_FOUND, { transactionId: id }));
    }
    targets.push(found);
  }

  const removed = new Set<string>(targets.map((transaction) => transaction.id));
  const groups = groupByPosition(targets);

  for (const group of groups.values()) {
    const guard = await guardReplayable(deps, group.key, (existing) => without(existing, removed));
    if (!guard.ok) return guard;
  }

  const deletedCount = await deps.transactions.deleteByIds([...removed] as TransactionId[]);

  const recalculations: RecalculationOutcome[] = [];
  for (const group of groups.values()) {
    const outcome = await recalculatePositionFrom(deps, {
      assetId: group.key.assetId,
      institutionId: group.key.institutionId,
      // DL-006-03: the earliest date touched in this position is where the
      // derived figures start being stale.
      fromDate: group.earliestDate,
    });
    if (!outcome.ok) return outcome;
    recalculations.push(outcome.value);
  }

  return ok({ deletedCount, recalculations });
}

interface PositionGroup {
  readonly key: PositionKey;
  readonly earliestDate: BusinessDate;
}

function groupByPosition(targets: readonly Transaction[]): ReadonlyMap<string, PositionGroup> {
  const groups = new Map<string, PositionGroup>();
  for (const transaction of targets) {
    const key: PositionKey = {
      assetId: transaction.assetId,
      institutionId: transaction.institutionId,
    };
    const id = positionKeyString(key);
    const existing = groups.get(id);
    if (existing === undefined || transaction.tradeDate < existing.earliestDate) {
      groups.set(id, { key, earliestDate: transaction.tradeDate });
    }
  }
  return groups;
}
