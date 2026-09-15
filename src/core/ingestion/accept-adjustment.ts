import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, ImportBatchId, InstitutionId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import { createTransaction, type CreateTransactionResult } from '@/core/ledger/create-transaction';
import type { Transaction } from '@/core/ledger/transaction';
import { replayPosition, selectForReplay } from '@/core/positions/replay';
import type { IngestionDependencies } from '@/core/ingestion/dependencies';
import { ingestionError, IngestionUseCaseErrorCode } from '@/core/ingestion/errors';
import type { ImportBatch } from '@/core/ingestion/ports';
import type { Discrepancy } from '@/core/ingestion/reconcile';

/**
 * SPEC-005 BR-005-25 — accepting B3's figure creates a dated, clearly-labelled
 * **adjustment transaction**. History is never edited in place (DL-005-06).
 *
 * A single row, not a bulk path — this reuses `core/ledger/create-transaction`
 * directly (its guard and single-position recalculation are exactly right
 * for one row, unlike `commit-batch.ts`'s grouped replay, which exists only
 * for the 10.000-row case).
 */
export interface AcceptAdjustmentInput {
  readonly batchId: ImportBatchId;
  readonly assetId: AssetId;
  readonly institutionId: InstitutionId | null;
}

export interface AcceptAdjustmentOutcome {
  readonly batch: ImportBatch;
  readonly result: CreateTransactionResult;
}

/**
 * SPEC-005 BR-005-25 (#110) — why B3's figure cannot be accepted **now**, or
 * `null` when it can. Asked of the current ledger at accept time, never of the
 * stored report, and asked the same way by the batch page, so the button is
 * hidden exactly where this use case would refuse.
 *
 * - `no_history`: no active transaction at or before the reconciliation date.
 *   The owner's first Posição was committed into an empty ledger: 72
 *   discrepancies of `computedQuantity` 0, all accepted, 72 adjustments for
 *   the full B3 quantity — and every position doubled when Negociação and
 *   Movimentação arrived two minutes later. Missing history is not a
 *   correction; the history is.
 *
 *   Keyed on "no active history" rather than on the cause:
 *   `missing_history_before_import_range` is also assigned to a position that
 *   has history but holds less than B3 (`reconcile.ts`), and that can still be
 *   a legitimate correction — a gap before the export range.
 *
 * - `stale`: the ledger's quantity is no longer the report's
 *   `computedQuantity`, so its stored difference is not the correction any
 *   more. This is how history imported after the report shows up once it
 *   exists: accepting 50 for a position that now holds 50 would double it just
 *   the same.
 *
 *   Measured the way `commit-batch.ts`'s `buildReconciliation` measured it —
 *   the whole ledger, not the ledger at the reconciliation date. Comparing at
 *   the date made every position traded after it permanently "stale", and
 *   re-importing Posição, which the hint asks for, computed the same figure.
 */
export type AdjustmentBlocker = 'no_history' | 'stale';

export function adjustmentBlocker(
  discrepancy: Discrepancy,
  ledger: readonly Transaction[],
  asOf: BusinessDate,
): AdjustmentBlocker | null {
  if (selectForReplay(ledger, { asOf }).length === 0) return 'no_history';
  const replayed = replayPosition(ledger);
  // A ledger that no longer replays has no quantity to compare: not the one reported.
  if (!replayed.ok) return 'stale';
  return replayed.value.quantity.equals(Quantity.fromString(discrepancy.computedQuantity))
    ? null
    : 'stale';
}

export async function acceptReconciliationAdjustment(
  deps: IngestionDependencies,
  userId: UserId,
  input: AcceptAdjustmentInput,
): Promise<Result<AcceptAdjustmentOutcome, DomainError>> {
  const batch = await deps.batches.findById(input.batchId);
  if (batch === null || batch.userId !== userId || batch.reconciliation === null) {
    return err(
      ingestionError(IngestionUseCaseErrorCode.BATCH_NOT_FOUND, { batchId: input.batchId }),
    );
  }

  const index = batch.reconciliation.discrepancies.findIndex(
    (d) => d.assetId === input.assetId && d.institutionId === input.institutionId && !d.resolved,
  );
  if (index === -1) {
    return err(
      ingestionError(IngestionUseCaseErrorCode.ROW_NOT_FOUND, {
        batchId: input.batchId,
        assetId: input.assetId,
      }),
    );
  }
  const discrepancy = batch.reconciliation.discrepancies[index] as Discrepancy;

  const existing = await deps.transactions.listForPosition(input.assetId, input.institutionId);

  // BR-005-25 (#110): refused, and nothing written, where missing or since
  // imported history — not B3 — explains the difference.
  const blocker = adjustmentBlocker(discrepancy, existing, batch.reconciliation.asOf);
  if (blocker !== null) {
    return err(
      ingestionError(
        blocker === 'no_history'
          ? IngestionUseCaseErrorCode.ADJUSTMENT_NO_HISTORY
          : IngestionUseCaseErrorCode.ADJUSTMENT_STALE,
        { batchId: input.batchId, assetId: input.assetId },
      ),
    );
  }

  const replayed = replayPosition(existing);
  const unitPrice = replayed.ok ? replayed.value.averageCost : Money.zero();

  const result = await createTransaction(deps, userId, {
    assetId: input.assetId,
    institutionId: input.institutionId,
    type: 'adjustment',
    tradeDate: batch.reconciliation.asOf,
    // SPEC-005 BR-005-25: signed — `b3Quantity - computedQuantity`, exactly
    // what `reconcile.ts` already computed and serialised.
    quantity: Quantity.fromString(discrepancy.difference),
    unitPrice,
    fees: Money.zero(),
    importBatchId: batch.id,
  });
  if (!result.ok) return result;

  const updatedDiscrepancies = batch.reconciliation.discrepancies.map((d, i) =>
    i === index ? { ...d, resolved: true } : d,
  );
  const updatedBatch: ImportBatch = {
    ...batch,
    reconciliation: { ...batch.reconciliation, discrepancies: updatedDiscrepancies },
  };
  await deps.batches.update(updatedBatch);

  return ok({ batch: updatedBatch, result: result.value });
}
