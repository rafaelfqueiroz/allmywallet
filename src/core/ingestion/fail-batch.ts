import type { DomainError } from '@/core/shared/domain-error';
import type { ImportBatchId, UserId } from '@/core/shared/ids';
import { type Result, err, ok } from '@/core/shared/result';
import type { IngestionDependencies } from '@/core/ingestion/dependencies';
import { ingestionError, IngestionUseCaseErrorCode } from '@/core/ingestion/errors';
import type { ImportBatch, IngestionErrorCode } from '@/core/ingestion/ports';

/**
 * SPEC-005 BR-005-05 (#63) — a parse failure is deterministic: re-parsing the
 * identical bytes fails identically, so retrying it buys nothing. This is
 * what makes it a **terminal** state rather than a variant of `pending` a
 * retry might resolve — `src/worker/handlers/import.ts`'s `import.stage`
 * calls this in place of throwing, so pg-boss never retries this path.
 *
 * The "delete the file" half of BR-005-12/DL-005-07's discipline is not here:
 * `core/` cannot touch a filesystem (AR-01). The handler deletes the file
 * only after this returns `ok` — the same ordering `cancelBatch` uses, so a
 * failure to persist the `failed` status can never leave a CPF-bearing file
 * deleted while the batch still claims to be `pending`.
 */
export interface FailBatchInput {
  readonly batchId: ImportBatchId;
  readonly code: IngestionErrorCode;
}

export async function failBatch(
  deps: IngestionDependencies,
  userId: UserId,
  input: FailBatchInput,
): Promise<Result<ImportBatch, DomainError>> {
  const batch = await deps.batches.findById(input.batchId);
  if (batch === null || batch.userId !== userId) {
    return err(
      ingestionError(IngestionUseCaseErrorCode.BATCH_NOT_FOUND, { batchId: input.batchId }),
    );
  }

  // AR-19-style idempotency: `import.stage` returns normally (does not throw)
  // on this path, so pg-boss will not redeliver the job under normal
  // operation — but a duplicate delivery must still be a safe no-op rather
  // than an error, exactly like `commitBatch`'s already-committed short
  // circuit.
  if (batch.status === 'failed' && batch.failureCode === input.code) {
    return ok(batch);
  }

  if (batch.status !== 'pending') {
    // Parsing runs before staging ever touches the batch (BR-005-09), so a
    // batch reaching this point should always still be `pending`. Anything
    // else is an unexpected state, not the deterministic case this function
    // exists to shortcut — the caller treats this the way it treats any other
    // unexpected failure: throw, keep the file, let a human see it.
    return err(
      ingestionError(IngestionUseCaseErrorCode.BATCH_NOT_PENDING, {
        batchId: input.batchId,
        status: batch.status,
      }),
    );
  }

  const failed: ImportBatch = { ...batch, status: 'failed', failureCode: input.code };
  await deps.batches.update(failed);
  return ok(failed);
}
