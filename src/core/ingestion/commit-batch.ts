import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import { TransactionId } from '@/core/shared/ids';
import type { ImportBatchId, ImportRowId, UserId } from '@/core/shared/ids';
import { type Result, err, ok } from '@/core/shared/result';
import { computeTotalValue, type Transaction } from '@/core/ledger/transaction';
import { validateTransactionDraft } from '@/core/ledger/validate';
import { type PositionKey, type PositionSnapshot, replayPosition } from '@/core/positions/replay';
import type { IngestionDependencies } from '@/core/ingestion/dependencies';
import { ingestionError, IngestionUseCaseErrorCode } from '@/core/ingestion/errors';
import type { ImportBatch, ImportRow } from '@/core/ingestion/ports';
import { reconcilePositions, type ReconciliationInput } from '@/core/ingestion/reconcile';

/**
 * SPEC-005 BR-005-13 — atomic apply to the ledger.
 *
 * **Atomicity, precisely.** BR-005-13's "applies fully or not at all" is the
 * *system* guarantee — a crash or a thrown error partway through leaves
 * nothing (the caller runs this inside one `withTenant` transaction, so a
 * Postgres rollback is what actually delivers this half; see
 * `tests/integration/import-commit.test.ts`'s interrupted-commit case). It is
 * not a guarantee that every staged row is individually applicable: a row
 * whose position cannot be replayed (BR-006-15 — selling more than was ever
 * bought, typically from missing history before the import range) is
 * excluded from *its own* insert and surfaced as `invalid`, rather than
 * failing the other 9.999 rows in the same commit. "Forgiving of user error"
 * (the issue's own framing) is why this reads BR-005-13 as per-position-group
 * atomicity for that one failure mode, not whole-batch.
 *
 * **Why this does not call `core/ledger/create-transaction.ts` per row.**
 * That use case replays the affected position after *every* insert — exactly
 * right for a single manual entry, and O(n²) for a 10.000-row commit
 * (BR-005-13's 60s budget). This groups candidates by `(asset, institution)`
 * and replays each group exactly once, whether it holds one row or a
 * thousand.
 */
export interface CommitBatchInput {
  readonly batchId: ImportBatchId;
}

export interface CommitBatchOutcome {
  readonly batch: ImportBatch;
  readonly applied: number;
  readonly skippedDuplicates: number;
  readonly invalid: number;
}

interface Candidate {
  readonly row: ImportRow;
  readonly transaction: Transaction;
}

export async function commitBatch(
  deps: IngestionDependencies,
  userId: UserId,
  input: CommitBatchInput,
): Promise<Result<CommitBatchOutcome, DomainError>> {
  const batch = await deps.batches.findById(input.batchId);
  if (batch === null || batch.userId !== userId) {
    return err(
      ingestionError(IngestionUseCaseErrorCode.BATCH_NOT_FOUND, { batchId: input.batchId }),
    );
  }

  // AR-19: a retried `import.commit` must not double-apply. A batch already
  // `committed` is a no-op success, not an error — exactly what a pg-boss
  // retry after a successful-but-unacknowledged first attempt needs.
  if (batch.status === 'committed') {
    return ok({ batch, applied: 0, skippedDuplicates: 0, invalid: 0 });
  }
  if (batch.status !== 'previewed') {
    return err(
      ingestionError(IngestionUseCaseErrorCode.BATCH_NOT_PREVIEWED, {
        batchId: input.batchId,
        status: batch.status,
      }),
    );
  }

  const rows = await deps.rows.listByBatch(batch.id);
  const now = deps.clock.now();
  const today = deps.clock.today();

  const duplicates = rows.filter((row) => row.classification === 'duplicate');
  const unclassifiedRows = rows.filter((row) => row.classification === 'unclassified');
  const newRows = rows.filter((row) => row.classification === 'new');
  const positionRows = rows.filter((row) => row.classification === 'position');

  const toInsert: Transaction[] = [];
  const positionUpserts: PositionSnapshot[] = [];
  const rowToTransaction = new Map<ImportRowId, TransactionId>();
  const invalidRowIds: ImportRowId[] = [];

  // `unclassified` rows are excluded from replay by `status`
  // (`selectForReplay`, SPEC-007), so they can never make a position
  // unreplayable and never need the group check below.
  for (const row of unclassifiedRows) {
    const transaction = buildCandidate(row, batch.id, userId, 'unclassified', now, today);
    if (transaction === null) {
      invalidRowIds.push(row.id);
      continue;
    }
    toInsert.push(transaction);
    rowToTransaction.set(row.id, transaction.id);
  }

  for (const group of groupByPosition(newRows)) {
    const candidates: Candidate[] = [];
    for (const row of group) {
      const transaction = buildCandidate(row, batch.id, userId, 'active', now, today);
      if (transaction === null) {
        invalidRowIds.push(row.id);
        continue;
      }
      candidates.push({ row, transaction });
    }
    const first = candidates[0];
    if (first === undefined) continue;

    const key: PositionKey = {
      assetId: first.transaction.assetId,
      institutionId: first.transaction.institutionId,
    };
    const existing = await deps.transactions.listForPosition(key.assetId, key.institutionId);
    const replayed = replayPosition([...existing, ...candidates.map((c) => c.transaction)]);

    if (!replayed.ok) {
      // BR-006-15 could not be satisfied for this group — every `new` row in
      // it is excluded (never written) and surfaced as `invalid`, not the
      // rest of the batch.
      for (const c of candidates) invalidRowIds.push(c.row.id);
      continue;
    }

    for (const c of candidates) {
      toInsert.push(c.transaction);
      rowToTransaction.set(c.row.id, c.transaction.id);
    }
    positionUpserts.push({ ...key, state: replayed.value });
  }

  for (const transaction of toInsert) {
    await deps.transactions.insert(transaction);
  }
  if (positionUpserts.length > 0) {
    await deps.positions.upsertMany(positionUpserts);
  }
  if (rowToTransaction.size > 0) {
    await deps.rows.attachTransactions(rowToTransaction);
  }
  for (const rowId of invalidRowIds) {
    await deps.rows.updateClassification(rowId, 'invalid');
  }

  // BR-005-06: create/update fixed-income contracts from the Posição
  // fixed-income tab before reconciliation reads the ledger.
  for (const row of positionRows) {
    if (row.record.kind !== 'position' || row.record.fixedIncome === null) continue;
    const fi = row.record.fixedIncome;
    // BR-009-13: no accrual base without an issue date — skip rather than
    // store a broken contract. The read side (`core/valuation/ports.ts`'s
    // `FixedIncomeContractPort`) requires a non-null `issueDate`.
    if (fi.issueDate === null) continue;
    await deps.fixedIncomeContracts.upsertByAsset({
      assetId: row.assetId,
      indexer: fi.indexer,
      ratePercent: fi.ratePercent,
      issueDate: fi.issueDate,
      maturityDate: fi.maturityDate,
      principal: fi.principal,
      source: batch.id,
    });
  }

  // BR-005-22: a Posição batch triggers reconciliation against what was just
  // committed (and everything committed before it).
  const reconciliation =
    batch.source === 'b3_posicao' && positionRows.length > 0
      ? await buildReconciliation(deps, positionRows, unclassifiedRows)
      : null;

  const committedBatch: ImportBatch = {
    ...batch,
    status: 'committed',
    committedAt: now,
    reconciliation,
  };
  await deps.batches.update(committedBatch);

  return ok({
    batch: committedBatch,
    applied: toInsert.length,
    skippedDuplicates: duplicates.length,
    invalid: invalidRowIds.length,
  });
}

function groupByPosition(rows: readonly ImportRow[]): readonly ImportRow[][] {
  const groups = new Map<string, ImportRow[]>();
  for (const row of rows) {
    const key = `${row.assetId}|${row.institutionId ?? ''}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return [...groups.values()];
}

/** `null` when the row's own fields fail `validateTransactionDraft` — a corrupt or contradictory extract row. */
function buildCandidate(
  row: ImportRow,
  batchId: ImportBatchId,
  userId: UserId,
  status: 'active' | 'unclassified',
  now: Date,
  today: BusinessDate,
): Transaction | null {
  if (row.record.kind !== 'transaction' || row.ledgerType === null || row.naturalKey === null) {
    return null;
  }
  const record = row.record;
  const draft = {
    type: row.ledgerType,
    tradeDate: record.tradeDate,
    quantity: record.quantity,
    unitPrice: record.unitPrice,
    fees: record.fees,
    ratio: record.ratio,
  };
  const validation = validateTransactionDraft(draft, today);
  if (!validation.ok) return null;

  return {
    id: TransactionId.generate(),
    userId,
    assetId: row.assetId,
    institutionId: row.institutionId,
    type: row.ledgerType,
    status,
    tradeDate: record.tradeDate,
    quantity: record.quantity,
    unitPrice: record.unitPrice,
    fees: record.fees,
    totalValue: computeTotalValue(row.ledgerType, record.quantity, record.unitPrice, record.fees),
    ratio: record.ratio,
    naturalKey: row.naturalKey,
    occurrence: row.occurrence ?? 1,
    importBatchId: batchId,
    isManual: false,
    isUserModified: false,
    createdAt: now,
    updatedAt: now,
  };
}

async function buildReconciliation(
  deps: IngestionDependencies,
  positionRows: readonly ImportRow[],
  unclassifiedRows: readonly ImportRow[],
): Promise<ImportBatch['reconciliation']> {
  const unclassifiedAssetKeys = new Set(
    unclassifiedRows.map((row) => `${row.assetId}|${row.institutionId ?? ''}`),
  );

  const inputs: ReconciliationInput[] = [];
  let asOf: BusinessDate | null = null;

  for (const row of positionRows) {
    if (row.record.kind !== 'position') continue;
    asOf = row.record.asOf;

    const existing = await deps.transactions.listForPosition(row.assetId, row.institutionId);
    const active = existing.filter((t) => t.status === 'active');
    const replayed = replayPosition(existing);
    // A ledger this reconciliation cannot replay is a defect upstream of it
    // (commit already refused to write anything unreplayable) — treated as
    // "nothing computed yet" rather than thrown, so one bad position never
    // blocks the reconciliation report for every other asset.
    const computedQuantity = replayed.ok ? replayed.value.quantity : row.record.quantity;
    const firstComputedTradeDate = active.reduce<BusinessDate | null>(
      (min, t) => (min === null || t.tradeDate < min ? t.tradeDate : min),
      null,
    );

    inputs.push({
      assetId: row.assetId,
      assetCode: row.record.assetCode,
      institutionId: row.institutionId,
      computedQuantity,
      b3Quantity: row.record.quantity,
      firstComputedTradeDate,
      hasUnclassifiedRowsAffectingAsset: unclassifiedAssetKeys.has(
        `${row.assetId}|${row.institutionId ?? ''}`,
      ),
    });
  }

  return reconcilePositions(asOf ?? deps.clock.today(), inputs);
}
