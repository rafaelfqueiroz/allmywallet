import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, ImportBatchId, InstitutionId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import { createTransaction, type CreateTransactionResult } from '@/core/ledger/create-transaction';
import { replayPosition } from '@/core/positions/replay';
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
