import type { DomainError } from '@/core/shared/domain-error';
import type { ImportRowId } from '@/core/shared/ids';
import type { Quantity } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import { createTransaction } from '@/core/ledger/create-transaction';
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
 *
 * An `ignored` row (BR-005-19 amended, #110) has no transaction to edit —
 * commit never wrote one — so classifying it *creates* one through SPEC-006's
 * `createTransaction`, which carries the same guard and recalculation. Its
 * key is the ledger's own natural key with the next free occurrence, so it
 * cannot collide with the Negociação trade it may mirror.
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

  if (row.classification === 'ignored' && row.record.kind === 'transaction') {
    const batch = await deps.batches.findById(row.batchId);
    // Committed only, as an `unclassified` row's transaction is: before commit
    // nothing from this batch is in the ledger (BR-005-09).
    if (batch === null || batch.status !== 'committed') {
      return notClassifiable(row.id, row.classification);
    }
    const created = await createTransaction(deps, batch.userId, {
      assetId: row.assetId,
      institutionId: row.institutionId,
      type: input.type,
      tradeDate: row.record.tradeDate,
      quantity: row.record.quantity,
      unitPrice: row.record.unitPrice,
      fees: row.record.fees,
      ratio: input.ratio ?? null,
      importBatchId: row.batchId,
    });
    if (!created.ok) return created;

    await deps.rows.attachTransactions(new Map([[row.id, created.value.transaction.id]]));
    await deps.rows.updateClassification(row.id, 'new');
    return ok({
      transaction: created.value.transaction,
      recalculations: [created.value.recalculation],
    });
  }

  if (row.classification !== 'unclassified' || row.transactionId === null) {
    return notClassifiable(row.id, row.classification);
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

function notClassifiable(rowId: ImportRowId, classification: string) {
  return err(
    ingestionError(IngestionUseCaseErrorCode.ROW_NOT_UNCLASSIFIED, { rowId, classification }),
  );
}
