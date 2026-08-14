import type { DomainError } from '@/core/shared/domain-error';
import type { ImportBatchId, UserId } from '@/core/shared/ids';
import { type Result, err, ok } from '@/core/shared/result';
import type { IngestionDependencies } from '@/core/ingestion/dependencies';
import { ingestionError, IngestionUseCaseErrorCode } from '@/core/ingestion/errors';
import type { ImportBatch } from '@/core/ingestion/ports';

/**
 * SPEC-005 BR-005-12 — cancel writes nothing to the ledger and deletes the
 * staged rows and the source file.
 *
 * The "source file" half is not here: `core/` cannot touch a filesystem
 * (AR-01), so `src/worker/handlers/import.ts`'s `import.cancel` path calls
 * this first (the transactional, database half) and only deletes the file on
 * disk once this returns `ok` — deleting the file before the database write
 * commits would leave a CPF-bearing file behind if the transaction then
 * rolled back for an unrelated reason.
 */
export interface CancelBatchInput {
  readonly batchId: ImportBatchId;
}

export interface CancelBatchOutcome {
  readonly batch: ImportBatch;
  readonly removedRows: number;
}

export async function cancelBatch(
  deps: IngestionDependencies,
  userId: UserId,
  input: CancelBatchInput,
): Promise<Result<CancelBatchOutcome, DomainError>> {
  const batch = await deps.batches.findById(input.batchId);
  if (batch === null || batch.userId !== userId) {
    return err(
      ingestionError(IngestionUseCaseErrorCode.BATCH_NOT_FOUND, { batchId: input.batchId }),
    );
  }
  if (batch.status === 'committed' || batch.status === 'discarded') {
    return err(
      ingestionError(IngestionUseCaseErrorCode.BATCH_NOT_CANCELLABLE, {
        batchId: input.batchId,
        status: batch.status,
      }),
    );
  }

  const removedRows = await deps.rows.deleteByBatch(batch.id);
  const cancelled: ImportBatch = { ...batch, status: 'discarded' };
  await deps.batches.update(cancelled);

  return ok({ batch: cancelled, removedRows });
}
