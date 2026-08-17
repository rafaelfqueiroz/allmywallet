import { describe, expect, it } from 'vitest';
import { ImportBatchId, UserId } from '@/core/shared/ids';
import { IngestionErrorCode } from '@/core/ingestion/ports';
import { failBatch } from '@/core/ingestion/fail-batch';
import { buildFakeIngestionDeps } from '@/core/ingestion/test-support/build-deps';

const userId = UserId.generate();

function pendingBatch(batchId: ImportBatchId) {
  return {
    id: batchId,
    userId,
    source: 'b3_movimentacao' as const,
    status: 'pending' as const,
    uploadedAt: new Date(),
    committedAt: null,
    rowCounts: null,
    reconciliation: null,
    failureCode: null,
  };
}

/**
 * SPEC-005 BR-005-05 (#63) — `failBatch` is the terminal transition
 * `handleImportStage` reaches for a deterministic parse failure. These cover
 * the use case in isolation; `tests/integration/import-pipeline.test.ts`
 * exercises the whole thing — worker handler, real Postgres, real file
 * deletion — end to end.
 */
describe('SPEC-005 BR-005-05 — failBatch', () => {
  it('marks a pending batch failed, carrying the parse error code', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = ImportBatchId.generate();
    deps.batches.seed(pendingBatch(batchId));

    const result = await failBatch(deps, userId, {
      batchId,
      code: IngestionErrorCode.MALFORMED_CELL,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('failed');
    expect(result.value.failureCode).toBe(IngestionErrorCode.MALFORMED_CELL);

    const stored = await deps.batches.findById(batchId);
    expect(stored?.status).toBe('failed');
    expect(stored?.failureCode).toBe(IngestionErrorCode.MALFORMED_CELL);
  });

  it('is idempotent: a batch already failed with the same code is a no-op success', async () => {
    // AR-19-style: `handleImportStage` returns normally on this path (does
    // not throw), so pg-boss should never redeliver `import.stage` for a
    // batch that already reached `failed` — but a duplicate delivery must
    // not error just because the first one already finished the job.
    const deps = buildFakeIngestionDeps();
    const batchId = ImportBatchId.generate();
    deps.batches.seed(pendingBatch(batchId));

    const first = await failBatch(deps, userId, {
      batchId,
      code: IngestionErrorCode.UNREADABLE_FILE,
    });
    expect(first.ok).toBe(true);

    const second = await failBatch(deps, userId, {
      batchId,
      code: IngestionErrorCode.UNREADABLE_FILE,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.status).toBe('failed');
    expect(second.value.failureCode).toBe(IngestionErrorCode.UNREADABLE_FILE);
  });

  it('refuses a batch that is not pending — an unexpected state, not the deterministic case this exists for', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = ImportBatchId.generate();
    deps.batches.seed({ ...pendingBatch(batchId), status: 'previewed' });

    const result = await failBatch(deps, userId, {
      batchId,
      code: IngestionErrorCode.MALFORMED_CELL,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_BATCH_NOT_PENDING');
  });

  it('refuses a batch already failed with a DIFFERENT code — not the redelivery case the idempotent short circuit covers', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = ImportBatchId.generate();
    deps.batches.seed(pendingBatch(batchId));
    await failBatch(deps, userId, { batchId, code: IngestionErrorCode.UNREADABLE_FILE });

    const result = await failBatch(deps, userId, {
      batchId,
      code: IngestionErrorCode.MALFORMED_CELL,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_BATCH_NOT_PENDING');
  });

  it('returns BATCH_NOT_FOUND for an unknown batch', async () => {
    const deps = buildFakeIngestionDeps();
    const result = await failBatch(deps, userId, {
      batchId: ImportBatchId.generate(),
      code: IngestionErrorCode.MALFORMED_CELL,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_BATCH_NOT_FOUND');
  });

  it('returns BATCH_NOT_FOUND for another tenant’s batch — AR-11/TS-17 shape at the use-case level', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = ImportBatchId.generate();
    deps.batches.seed(pendingBatch(batchId));

    const result = await failBatch(deps, UserId.generate(), {
      batchId,
      code: IngestionErrorCode.MALFORMED_CELL,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_BATCH_NOT_FOUND');
  });
});
