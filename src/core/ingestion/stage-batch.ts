import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { ImportBatchId, UserId } from '@/core/shared/ids';
import { ImportRowId } from '@/core/shared/ids';
import { type Result, err, ok } from '@/core/shared/result';
import type { TransactionType } from '@/core/ledger/transaction';
import type { IngestionDependencies } from '@/core/ingestion/dependencies';
import { ingestionError, IngestionUseCaseErrorCode } from '@/core/ingestion/errors';
import {
  UNCLASSIFIED_PLACEHOLDER_TYPE,
  importNaturalKeyFor,
  planOccurrences,
} from '@/core/ingestion/occurrence';
import { classifyMovement } from '@/core/ingestion/movement-map';
import type {
  ImportBatch,
  ImportRow,
  ImportRowCounts,
  ParsedExtract,
  ParsedRecord,
} from '@/core/ingestion/ports';

/**
 * SPEC-005 BR-005-09..11 — parse → classify → stage.
 *
 * `extract` is handed in already parsed: the `.xlsx` parsing itself
 * (`adapters/ingestion/xlsx/`) runs in the worker handler, outside `core/`
 * (AR-01) and outside this use case, which is what keeps this file testable
 * with a hand-built `ParsedExtract` and no file at all.
 *
 * Nothing is written to `transactions` here — BR-005-09's "nothing reaches
 * the ledger before user confirmation" is why staging only ever writes
 * `import_rows` and moves the batch to `previewed`.
 *
 * A single extract is, in practice, homogeneous: Movimentação and Negociação
 * files carry only transaction rows, Posição only position rows (BR-005-01).
 * This is what lets the two kinds be handled as two separate, simple passes
 * below rather than one pass interleaving both.
 */
export interface StageBatchInput {
  readonly batchId: ImportBatchId;
  readonly extract: ParsedExtract;
}

export interface StageBatchOutcome {
  readonly batch: ImportBatch;
  readonly rows: readonly ImportRow[];
  readonly counts: ImportRowCounts;
  /** BR-005-21: the raw B3 type strings the movement map could not classify — logged by the caller, no values (BR-004-04). */
  readonly unmappedTypes: readonly string[];
}

export async function stageBatch(
  deps: IngestionDependencies,
  userId: UserId,
  input: StageBatchInput,
): Promise<Result<StageBatchOutcome, DomainError>> {
  const batch = await deps.batches.findById(input.batchId);
  if (batch === null || batch.userId !== userId) {
    return err(
      ingestionError(IngestionUseCaseErrorCode.BATCH_NOT_FOUND, { batchId: input.batchId }),
    );
  }
  if (batch.status !== 'pending') {
    return err(
      ingestionError(IngestionUseCaseErrorCode.BATCH_NOT_PENDING, {
        batchId: input.batchId,
        status: batch.status,
      }),
    );
  }
  if (input.extract.records.length === 0) {
    return err(ingestionError(IngestionUseCaseErrorCode.EMPTY_EXTRACT, { batchId: input.batchId }));
  }

  const rows: ImportRow[] =
    input.extract.extractType === 'b3_posicao'
      ? await stagePositionRows(deps, batch.id, input.extract.records)
      : await stageTransactionRows(deps, batch.id, input.extract.records);

  await deps.rows.insertMany(rows);

  const counts = summarize(input.extract.records.length, rows);
  const unmappedTypeSet = new Set<string>();
  for (const row of rows) {
    if (row.classification === 'unclassified' && row.record.kind === 'transaction') {
      unmappedTypeSet.add(row.record.b3Type);
    }
  }
  const unmappedTypes = [...unmappedTypeSet];

  // BR-005-03: `source` is corrected to the *detected* type here — at
  // creation time (before any byte has been parsed, in the upload action)
  // it is necessarily a placeholder, since which of the three extracts a
  // file is is exactly what structure detection determines. Staging is the
  // first point that placeholder can be replaced with the truth.
  const updatedBatch: ImportBatch = {
    ...batch,
    source: input.extract.extractType,
    status: 'previewed',
    rowCounts: counts,
  };
  await deps.batches.update(updatedBatch);

  return ok({ batch: updatedBatch, rows, counts, unmappedTypes });
}

async function stagePositionRows(
  deps: IngestionDependencies,
  batchId: ImportBatchId,
  records: readonly ParsedRecord[],
): Promise<ImportRow[]> {
  const rows: ImportRow[] = [];
  for (const parsed of records) {
    if (parsed.record.kind !== 'position') continue;
    const assetId = await deps.assets.resolve({
      code: parsed.record.assetCode,
      name: parsed.record.assetName,
      assetClass: parsed.record.assetClass,
    });
    const institutionId =
      parsed.record.institutionName === null
        ? null
        : await deps.institutions.resolve(parsed.record.institutionName);
    rows.push({
      id: ImportRowId.generate(),
      batchId,
      raw: parsed.raw,
      record: parsed.record,
      assetId,
      institutionId,
      classification: 'position',
      naturalKey: null,
      occurrence: null,
      ledgerType: null,
      transactionId: null,
    });
  }
  return rows;
}

async function stageTransactionRows(
  deps: IngestionDependencies,
  batchId: ImportBatchId,
  records: readonly ParsedRecord[],
): Promise<ImportRow[]> {
  interface Resolved {
    readonly raw: ParsedRecord['raw'];
    readonly record: Extract<ParsedRecord['record'], { kind: 'transaction' }>;
    readonly assetId: Awaited<ReturnType<IngestionDependencies['assets']['resolve']>>;
    readonly institutionId: Awaited<
      ReturnType<IngestionDependencies['institutions']['resolve']>
    > | null;
    readonly isUnclassified: boolean;
    readonly ledgerType: TransactionType;
    readonly naturalKey: string;
  }

  const resolved: Resolved[] = [];
  for (const parsed of records) {
    if (parsed.record.kind !== 'transaction') continue;
    const record = parsed.record;
    const assetId = await deps.assets.resolve({
      code: record.assetCode,
      name: record.assetName,
      assetClass: record.assetClass,
    });
    const institutionId =
      record.institutionName === null
        ? null
        : await deps.institutions.resolve(record.institutionName);

    // BR-005-18: mapped types are classified; BR-005-19: an unmapped one is
    // never dropped — it is staged `unclassified` with a placeholder type
    // (`occurrence.ts`), not rejected. `direction` disambiguates a handful of
    // Movimentação strings that mean opposite things by Entrada/Saída.
    const resolvedType = classifyMovement(record.b3Type, record.direction);
    const isUnclassified = resolvedType === null;
    const ledgerType = resolvedType ?? UNCLASSIFIED_PLACEHOLDER_TYPE;

    const naturalKey = importNaturalKeyFor(
      {
        assetId,
        institutionId,
        type: ledgerType,
        tradeDate: record.tradeDate,
        quantity: record.quantity,
        unitPrice: record.unitPrice,
      },
      isUnclassified ? record.b3Type : null,
    );

    resolved.push({
      raw: parsed.raw,
      record,
      assetId,
      institutionId,
      isUnclassified,
      ledgerType,
      naturalKey,
    });
  }

  // BR-005-15/16/17: one grouped occurrence query for the whole batch.
  const uniqueKeys = [...new Set(resolved.map((row) => row.naturalKey))];
  const existingCounts = await deps.transactions.occurrenceCounts(uniqueKeys);
  const planned = planOccurrences(resolved, existingCounts);

  return planned.map((row) => ({
    id: ImportRowId.generate(),
    batchId,
    raw: row.raw,
    record: row.record,
    assetId: row.assetId,
    institutionId: row.institutionId,
    classification: row.isDuplicate ? 'duplicate' : row.isUnclassified ? 'unclassified' : 'new',
    naturalKey: row.naturalKey,
    occurrence: row.occurrence,
    ledgerType: row.ledgerType,
    transactionId: null,
  }));
}

function summarize(read: number, rows: readonly ImportRow[]): ImportRowCounts {
  let newCount = 0;
  let duplicateCount = 0;
  let needsAttentionCount = 0;
  let fromDate: BusinessDate | null = null;
  let toDate: BusinessDate | null = null;

  for (const row of rows) {
    if (row.classification === 'new') newCount += 1;
    else if (row.classification === 'duplicate') duplicateCount += 1;
    else if (row.classification === 'unclassified' || row.classification === 'invalid') {
      needsAttentionCount += 1;
    }

    if (row.record.kind !== 'transaction') continue;
    const date = row.record.tradeDate;
    if (fromDate === null || date < fromDate) fromDate = date;
    if (toDate === null || date > toDate) toDate = date;
  }

  return {
    read,
    new: newCount,
    duplicates: duplicateCount,
    needsAttention: needsAttentionCount,
    fromDate,
    toDate,
  };
}
