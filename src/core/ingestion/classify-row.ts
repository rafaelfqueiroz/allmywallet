import type { DomainError } from '@/core/shared/domain-error';
import type { ImportRowId } from '@/core/shared/ids';
import type { Quantity } from '@/core/shared/money';
import { type Result, err } from '@/core/shared/result';
import { editTransaction, type EditTransactionResult } from '@/core/ledger/edit-transaction';
import type { TransactionType } from '@/core/ledger/transaction';
import type { IngestionDependencies } from '@/core/ingestion/dependencies';
import { ingestionError, IngestionUseCaseErrorCode } from '@/core/ingestion/errors';

/**
 * SPEC-005 BR-005-20 — manually classifying an `unclassified` row brings it
 * into calculations.
 *
 * This is deliberately a thin wrapper over SPEC-006's
 * `core/ledger/edit-transaction.ts`, not a second implementation: setting a
 * real `type` and flipping `status` to `active` on an already-committed
 * `unclassified` transaction *is* an edit, and `editTransaction` already does
 * everything BR-005-20's acceptance criterion needs — BR-006-15's guard,
 * BR-006-16's `is_user_modified` (so a later re-import cannot revert the
 * classification) and forward recalculation (DL-006-03). Reimplementing any
 * of that here would be a second place those rules could drift from the
 * first (`IngestionDependencies` satisfies `LedgerDependencies` structurally,
 * since it carries `transactions`/`positions`/`clock`).
 */
export interface ClassifyImportRowInput {
  readonly rowId: ImportRowId;
  readonly type: TransactionType;
  readonly ratio?: Quantity | null | undefined;
}

export async function classifyImportRow(
  deps: IngestionDependencies,
  input: ClassifyImportRowInput,
): Promise<Result<EditTransactionResult, DomainError>> {
  const row = await deps.rows.findById(input.rowId);
  if (row === null) {
    return err(ingestionError(IngestionUseCaseErrorCode.ROW_NOT_FOUND, { rowId: input.rowId }));
  }
  if (row.classification !== 'unclassified' || row.transactionId === null) {
    return err(
      ingestionError(IngestionUseCaseErrorCode.ROW_NOT_UNCLASSIFIED, {
        rowId: input.rowId,
        classification: row.classification,
      }),
    );
  }

  const result = await editTransaction(deps, row.transactionId, {
    type: input.type,
    status: 'active',
    ratio: input.ratio ?? null,
    // BR-005-17: the B3 row this transaction came from has not changed, so
    // neither has the key a re-import of that file will compute. See
    // `EditTransactionInput.preserveNaturalKey`.
    preserveNaturalKey: true,
  });
  if (!result.ok) return result;

  // BR-005-19: classifying is what removes a row from the "Needs attention"
  // queue — `new` is the same terminal state a row that matched the movement
  // map on first import reaches.
  await deps.rows.updateClassification(row.id, 'new');

  return result;
}
