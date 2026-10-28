import type { DomainError } from '@/core/shared/domain-error';
import type { ImportBatchId, ImportRowId } from '@/core/shared/ids';
import { type Result, err, ok } from '@/core/shared/result';
import type { IngestionDependencies } from '@/core/ingestion/dependencies';
import { ingestionError, IngestionUseCaseErrorCode } from '@/core/ingestion/errors';
import { summarizeRows } from '@/core/ingestion/stage-batch';

/**
 * SPEC-005 BR-005-20f (#215, DL-005-31) — the user marks an `unclassified` row
 * `ignored`, with a stated reason.
 *
 * For evidence no rule should ever activate — a statement that moves no
 * position, a redemption of paper with no recorded acquisition (#158 D5–D8).
 * Without this the row would sit in "Precisa da sua atenção" for good, which
 * teaches the user to stop reading the queue.
 *
 * **Nothing reaches the ledger.** Commit stored the row's copy `unclassified`,
 * already excluded from replay (SPEC-006 DL-006-06); it becomes `superseded`,
 * equally excluded, so no position, snapshot or allocation changes and nothing
 * is recalculated. It is the state a re-import leaves a mirror row's stored
 * copy in (BR-005-19), and that matters twice over:
 *
 * - BR-005-20 brings an `ignored` row back by restoring its `superseded` copy
 *   (`classify-row.ts`), keeping the key and occurrence staging gave it;
 * - a re-import that now maps the row's type promotes only an `unclassified`
 *   copy (BR-005-20), so it cannot quietly undo the user's decision. The copy
 *   is also flagged user-modified, which every automatic path already defers to
 *   (SPEC-006 BR-006-16).
 *
 * The reason is the user's own text: it is stored with the row and never
 * logged or put in an error's context (BR-004-04).
 */
export const IGNORE_REASON_MAX_LENGTH = 500;

export interface IgnoreImportRowInput {
  readonly rowId: ImportRowId;
  readonly reason: string;
}

export async function ignoreImportRow(
  deps: IngestionDependencies,
  input: IgnoreImportRowInput,
): Promise<Result<{ readonly rowId: ImportRowId; readonly batchId: ImportBatchId }, DomainError>> {
  const reason = input.reason.trim();
  // A NUL is refused rather than stored: Postgres `text` rejects it, and the
  // driver's error would carry the user's text into a log (BR-004-04).
  if (
    reason.length === 0 ||
    reason.length > IGNORE_REASON_MAX_LENGTH ||
    reason.includes('\u0000')
  ) {
    return err(
      ingestionError(IngestionUseCaseErrorCode.IGNORE_REASON_INVALID, {
        maxLength: IGNORE_REASON_MAX_LENGTH,
      }),
    );
  }

  // PR #267 review: before the read. The conditional writes below refuse a
  // state another write already committed; this lock keeps a commit that is
  // still running — one that read the copy `unclassified` and will write it
  // `active` — from overwriting this ignore after it succeeds. Each waits for
  // the other, so whichever comes second sees what the first did.
  await deps.batches.lockImportWrites();
  const row = await deps.rows.findById(input.rowId);
  if (row === null) {
    return err(ingestionError(IngestionUseCaseErrorCode.ROW_NOT_FOUND, { rowId: input.rowId }));
  }

  // BR-005-20f names `unclassified` only. An `invalid` row is a refusal whose
  // cause the batch screen states; a classified one is already settled. A row
  // with no stored copy belongs to a batch not yet committed (BR-005-09), whose
  // rows cancelling deletes outright.
  const refused = err(
    ingestionError(IngestionUseCaseErrorCode.ROW_NOT_UNCLASSIFIED, {
      rowId: row.id,
      classification: row.classification,
    }),
  );
  if (row.classification !== 'unclassified' || row.transactionId === null) return refused;

  // Both writes are conditional, so a submission that went stale while it was
  // in flight — the row classified, or a re-import that activated its copy —
  // is refused rather than overwriting the newer state (PR #267 review). The
  // read above alone cannot do that: another transaction may commit between
  // it and these writes. A refusal after the first write relies on the caller
  // rolling the tenant transaction back on a refused result (`withTenantResult`).
  if (!(await deps.transactions.supersedeUnclassified(row.transactionId, deps.clock.now()))) {
    return refused;
  }
  if (!(await deps.rows.markIgnored(row.id, reason))) return refused;

  await recountBatch(deps, row.batchId);

  return ok({ rowId: row.id, batchId: row.batchId });
}

/**
 * BR-005-10: the batch's stored counts say what each row became. Recounted
 * from the rows rather than adjusted by one, so a row ignored and later brought
 * back (BR-005-20) cannot leave the counts behind it.
 */
export async function recountBatch(
  deps: IngestionDependencies,
  batchId: ImportBatchId,
): Promise<void> {
  const batch = await deps.batches.findById(batchId);
  if (batch === null || batch.rowCounts === null) return;
  await deps.batches.update({
    ...batch,
    rowCounts: summarizeRows(batch.rowCounts.read, await deps.rows.listByBatch(batchId)),
  });
}
