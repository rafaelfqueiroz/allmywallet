import { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import { TransactionId } from '@/core/shared/ids';
import type { ImportBatchId, ImportRowId, UserId } from '@/core/shared/ids';
import type { Quantity } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import { editTransaction } from '@/core/ledger/edit-transaction';
import { computeTotalValue, type Transaction } from '@/core/ledger/transaction';
import { validateTransactionDraft } from '@/core/ledger/validate';
import {
  type PositionKey,
  type PositionSnapshot,
  positionKeyString,
  replayPosition,
} from '@/core/positions/replay';
import type { PositionState } from '@/core/positions/position-state';
import type { IngestionDependencies } from '@/core/ingestion/dependencies';
import { ingestionError, IngestionUseCaseErrorCode } from '@/core/ingestion/errors';
import type { ImportBatch, ImportRow } from '@/core/ingestion/ports';
import { reconcilePositions, type ReconciliationInput } from '@/core/ingestion/reconcile';
import {
  type CarryLeg,
  isCarryCandidate,
  pairTransfers,
  resolveCarriedCosts,
  type TransferLeg,
  withCarriedCost,
} from '@/core/ingestion/transfer-cost';

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
 * and replays each group once per settling round (see `settle`).
 */
export interface CommitBatchInput {
  readonly batchId: ImportBatchId;
  /**
   * SPEC-005 BR-005-22 (amended, #108) — the date B3's snapshot describes,
   * **confirmed by the user** on the preview. The real Posição export states it
   * nowhere inside the file, and DL-005-03 rules out the filename. Required for
   * a Posição batch, ignored for the other two.
   */
  readonly asOf?: BusinessDate;
}

export interface CommitBatchOutcome {
  readonly batch: ImportBatch;
  readonly applied: number;
  /** BR-005-20a (#110): existing unclassified transfers this commit gave their carried cost. */
  readonly promoted: number;
  readonly skippedDuplicates: number;
  readonly invalid: number;
  /**
   * SPEC-010 BR-010-10/17/18 — what the caller has to apply to wallet
   * allocations, in the same transaction.
   *
   * Carried rather than re-queried because a second read could not tell this
   * batch's rows from any other's, and applying a buy twice would allocate it
   * twice. It is deliberately the domain objects that were just written, not
   * a bespoke summary type: the wallet side needs type, quantity, ratio and
   * trade date, which is most of a `Transaction` anyway, and a parallel shape
   * would be one more thing to keep in step.
   *
   * Promoted transfers are included: they enter calculations in this commit,
   * so the snapshot rebuild must start no later than their trade date.
   *
   * `core/ingestion` still knows nothing about wallets — it reports what it
   * did, and `core/wallets/apply-ledger-effects.ts` decides what that means.
   */
  readonly committed: readonly Transaction[];
}

interface Candidate {
  readonly row: ImportRow;
  readonly transaction: Transaction;
}

/** A carry leg with the row it came from; `promotesFrom` is set when the credit is an existing unclassified transaction. */
interface PlannedCarry extends CarryLeg {
  readonly row: ImportRow;
  readonly promotesFrom: ImportBatchId | null;
}

interface CarriedCredit {
  readonly leg: PlannedCarry;
  readonly transaction: Transaction;
}

interface Group {
  readonly key: PositionKey;
  readonly candidates: Candidate[];
  readonly carried: CarriedCredit[];
  readonly state: PositionState | null;
}

type StoredLedger = (key: PositionKey) => readonly Transaction[];

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
    // AR-19: a no-op success carries no effects either — a retry must not
    // re-apply wallet allocations for a batch that already applied them.
    return ok({
      batch,
      applied: 0,
      promoted: 0,
      skippedDuplicates: 0,
      invalid: 0,
      committed: [],
    });
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

  // BR-005-22 (amended, #108): checked before any write, so a Posição commit
  // missing its reference date changes nothing rather than half-applying.
  let asOf: BusinessDate | null = null;
  if (batch.source === 'b3_posicao' && positionRows.length > 0) {
    if (input.asOf === undefined) {
      return err(
        ingestionError(IngestionUseCaseErrorCode.REFERENCE_DATE_REQUIRED, { batchId: batch.id }),
      );
    }
    if (BusinessDate.isBefore(today, input.asOf)) {
      return err(
        ingestionError(IngestionUseCaseErrorCode.REFERENCE_DATE_IN_FUTURE, { batchId: batch.id }),
      );
    }
    asOf = input.asOf;
  }

  const invalidRowIds: ImportRowId[] = [];
  const newCandidates: Candidate[] = [];
  for (const row of newRows) {
    const transaction = buildCandidate(row, batch.id, userId, 'active', now, today);
    if (transaction === null) invalidRowIds.push(row.id);
    else newCandidates.push({ row, transaction });
  }

  const stored = await loadLedgers(deps, rows);
  const carryLegs = planCarries(rows, newCandidates, stored, batch.id, userId, now, today);

  /**
   * SPEC-005 BR-005-20a (#110) — carries are resolved here, at commit, where
   * the source's history is this batch's rows plus the ledger, rather than at
   * staging, where it was the ledger alone.
   *
   * A carry and a group's replay depend on each other: a debit whose source
   * group fails is never written, so nothing may be carried from it, and a
   * credit into a group that fails is not written either. So the two are
   * settled together: each round resolves carries, replays every group, and
   * excludes what failed. Exclusions only grow, so the rounds end; in practice
   * the first round is the last.
   */
  const excluded = new Set<string>();
  const vetoed = new Set<string>();
  let settlement = settle(newCandidates, carryLegs, stored, excluded, vetoed);
  for (
    let failed = settlement.filter((group) => group.state === null);
    failed.length > 0;
    failed = settlement.filter((group) => group.state === null)
  ) {
    for (const group of failed) {
      // BR-006-15 could not be satisfied for this group — every `new` row in
      // it is excluded (never written) and surfaced as `invalid`, not the
      // rest of the batch. A carried credit in it falls back to `unclassified`.
      for (const c of group.candidates) excluded.add(c.row.id);
      for (const c of group.carried) vetoed.add(c.leg.id);
    }
    settlement = settle(newCandidates, carryLegs, stored, excluded, vetoed);
  }
  for (const c of newCandidates) if (excluded.has(c.row.id)) invalidRowIds.push(c.row.id);

  const toInsert: Transaction[] = [];
  const positionUpserts: PositionSnapshot[] = [];
  const rowToTransaction = new Map<ImportRowId, TransactionId>();
  const carriedRowIds = new Set<ImportRowId>();
  const promotions: CarriedCredit[] = [];

  for (const group of settlement) {
    // Every group left in the final round replayed.
    if (group.state === null) continue;
    for (const c of group.candidates) {
      toInsert.push(c.transaction);
      rowToTransaction.set(c.row.id, c.transaction.id);
    }
    for (const c of group.carried) {
      if (c.leg.promotesFrom !== null) {
        promotions.push(c);
        continue;
      }
      toInsert.push(c.transaction);
      rowToTransaction.set(c.leg.row.id, c.transaction.id);
      carriedRowIds.add(c.leg.row.id);
    }
    positionUpserts.push({ ...group.key, state: group.state });
  }

  // `unclassified` rows are excluded from replay by `status`
  // (`selectForReplay`, SPEC-007), so they can never make a position
  // unreplayable and never need the group check above.
  for (const row of unclassifiedRows) {
    if (carriedRowIds.has(row.id)) continue;
    const transaction = buildCandidate(row, batch.id, userId, 'unclassified', now, today);
    if (transaction === null) {
      invalidRowIds.push(row.id);
      continue;
    }
    toInsert.push(transaction);
    rowToTransaction.set(row.id, transaction.id);
  }

  // BR-005-13: one write for the whole batch. Written row by row this was
  // ten thousand sequential round trips and 57 of the rule's 60 seconds.
  //
  // Guarded like the two writes below it: a batch that is entirely duplicates
  // applies nothing, and should issue no statement at all rather than an empty
  // insert — which `commit-batch.test.ts` asserts by counting writes.
  if (toInsert.length > 0) {
    await deps.transactions.insertMany(toInsert);
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
  // BR-005-19/20a: a carried credit no longer needs attention.
  for (const rowId of carriedRowIds) {
    await deps.rows.updateClassification(rowId, 'new');
  }

  const promoted = await promoteTransfers(deps, promotions);

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
  const stillUnclassified = unclassifiedRows.filter((row) => !carriedRowIds.has(row.id));
  const reconciliation =
    asOf !== null ? await buildReconciliation(deps, asOf, positionRows, stillUnclassified) : null;

  const committedBatch: ImportBatch = {
    ...batch,
    status: 'committed',
    committedAt: now,
    reconciliation,
    // BR-005-10: the preview counted a carried credit as needing attention;
    // the committed batch reports what it became.
    rowCounts:
      batch.rowCounts === null || carriedRowIds.size === 0
        ? batch.rowCounts
        : {
            ...batch.rowCounts,
            new: batch.rowCounts.new + carriedRowIds.size,
            needsAttention: batch.rowCounts.needsAttention - carriedRowIds.size,
          },
  };
  await deps.batches.update(committedBatch);

  return ok({
    batch: committedBatch,
    applied: toInsert.length,
    promoted: promoted.length,
    skippedDuplicates: duplicates.length,
    invalid: invalidRowIds.length,
    committed: [...toInsert, ...promoted],
  });
}

/**
 * The stored ledger of every position this commit can touch: those its `new`
 * rows land in, and those either side of a transfer. Loaded once, so settling
 * rounds and carries never query again.
 */
async function loadLedgers(
  deps: IngestionDependencies,
  rows: readonly ImportRow[],
): Promise<StoredLedger> {
  const ledgers = new Map<string, readonly Transaction[]>();
  for (const row of rows) {
    const touches =
      row.classification === 'new' ||
      row.ledgerType === 'transfer_in' ||
      row.ledgerType === 'transfer_out';
    if (!touches || row.record.kind !== 'transaction') continue;
    const key = positionKeyString(row);
    if (ledgers.has(key)) continue;
    ledgers.set(key, await deps.transactions.listForPosition(row.assetId, row.institutionId));
  }
  return (key) => ledgers.get(positionKeyString(key)) ?? [];
}

/** The stored transaction a staged `duplicate` row stands for — same key, same occurrence. */
function storedCopyOf(stored: StoredLedger, row: ImportRow): Transaction | undefined {
  return stored(row).find(
    (t) => t.naturalKey === row.naturalKey && t.occurrence === row.occurrence,
  );
}

/**
 * BR-005-20a — the credits that can take a carried cost in this commit, each
 * with the debit it is paired with (`pairTransfers`).
 *
 * A credit is either a price-less row staged `unclassified`, or — #110, import
 * order must not decide the outcome — a `duplicate` of an **existing**
 * unclassified `transfer_in` that no one has edited: the same B3 row, imported
 * before its source's history was, now able to take its cost.
 */
function planCarries(
  rows: readonly ImportRow[],
  newCandidates: readonly Candidate[],
  stored: StoredLedger,
  batchId: ImportBatchId,
  userId: UserId,
  now: Date,
  today: BusinessDate,
): readonly PlannedCarry[] {
  const legOf = (row: ImportRow): TransferLeg[] =>
    row.record.kind === 'transaction'
      ? [
          {
            id: row.id,
            assetId: row.assetId,
            institutionId: row.institutionId,
            tradeDate: row.record.tradeDate,
            quantity: row.record.quantity,
          },
        ]
      : [];
  const inLedger = (row: ImportRow) =>
    row.classification === 'new' || row.classification === 'duplicate';

  const pairs = pairTransfers(
    rows
      .filter(
        (row) =>
          row.ledgerType === 'transfer_in' &&
          (inLedger(row) || row.classification === 'unclassified'),
      )
      .flatMap(legOf),
    rows.filter((row) => row.ledgerType === 'transfer_out' && inLedger(row)).flatMap(legOf),
  );

  const byId = new Map<string, ImportRow>(rows.map((row) => [row.id, row]));
  const candidateById = new Map<string, Transaction>(
    newCandidates.map((c) => [c.row.id, c.transaction]),
  );

  const planned: PlannedCarry[] = [];
  for (const [creditId, debitId] of pairs) {
    const creditRow = byId.get(creditId);
    const debitRow = byId.get(debitId);
    if (creditRow === undefined || debitRow === undefined || !isCarryCandidate(creditRow)) {
      continue;
    }

    let credit: Transaction | null = null;
    let promotesFrom: ImportBatchId | null = null;
    if (creditRow.classification === 'unclassified') {
      credit = buildCandidate(creditRow, batchId, userId, 'active', now, today);
    } else if (creditRow.classification === 'duplicate') {
      const existing = storedCopyOf(stored, creditRow);
      if (
        existing !== undefined &&
        existing.status === 'unclassified' &&
        existing.type === 'transfer_in' &&
        !existing.isUserModified &&
        existing.importBatchId !== null
      ) {
        credit = { ...existing, status: 'active' };
        promotesFrom = existing.importBatchId;
      }
    }
    if (credit === null) continue;

    const storedDebit = storedCopyOf(stored, debitRow);
    const debit =
      debitRow.classification === 'new'
        ? (candidateById.get(debitId) ?? null)
        : storedDebit !== undefined &&
            storedDebit.type === 'transfer_out' &&
            storedDebit.status === 'active'
          ? storedDebit
          : null;

    planned.push({ id: creditId, row: creditRow, credit, debit, promotesFrom });
  }
  return planned;
}

/** One settling round: resolve carries against what is not excluded, then replay every group. */
function settle(
  newCandidates: readonly Candidate[],
  carryLegs: readonly PlannedCarry[],
  stored: StoredLedger,
  excluded: ReadonlySet<string>,
  vetoed: ReadonlySet<string>,
): Group[] {
  const live = newCandidates.filter((c) => !excluded.has(c.row.id));
  const excludedTransactions = new Set<string>(
    newCandidates.filter((c) => excluded.has(c.row.id)).map((c) => c.transaction.id),
  );
  const legs = carryLegs
    .filter((leg) => !vetoed.has(leg.id))
    .map((leg) => ({
      ...leg,
      debit: leg.debit !== null && excludedTransactions.has(leg.debit.id) ? null : leg.debit,
    }));

  const costs = resolveCarriedCosts(legs, (assetId, institutionId) => [
    ...stored({ assetId, institutionId }),
    ...live
      .filter((c) => c.row.assetId === assetId && c.row.institutionId === institutionId)
      .map((c) => c.transaction),
  ]);

  const groups = new Map<
    string,
    { key: PositionKey; candidates: Candidate[]; carried: CarriedCredit[] }
  >();
  const groupOf = (key: PositionKey) => {
    const id = positionKeyString(key);
    const existing = groups.get(id);
    if (existing !== undefined) return existing;
    const created = {
      key: { assetId: key.assetId, institutionId: key.institutionId },
      candidates: [],
      carried: [],
    };
    groups.set(id, created);
    return created;
  };
  for (const c of live) groupOf(c.transaction).candidates.push(c);
  for (const leg of legs) {
    const cost = costs.get(leg.id);
    if (cost === undefined) continue;
    groupOf(leg.credit).carried.push({ leg, transaction: withCarriedCost(leg.credit, cost) });
  }

  return [...groups.values()].map((group) => {
    // A promoted credit is in `stored` as its unclassified self too; replay
    // selects `active` rows only, so the carried copy is the one that counts.
    const replayed = replayPosition([
      ...stored(group.key),
      ...group.candidates.map((c) => c.transaction),
      ...group.carried.map((c) => c.transaction),
    ]);
    return { ...group, state: replayed.ok ? replayed.value : null };
  });
}

/**
 * BR-005-20a (#110) — an existing unclassified transfer takes its carried cost
 * in place: the same B3 row gaining information, not a new row, so its key is
 * kept (BR-005-17) and it is not badged as a user's edit (BR-006-16). Through
 * `editTransaction`, so BR-006-15's guard and the recalculation still run.
 *
 * The settling round already replayed this exact ledger, so a refusal here is
 * a defect, not a user error — thrown, so the whole commit rolls back
 * (BR-005-13) rather than leaving positions written for a promotion that
 * never happened.
 */
async function promoteTransfers(
  deps: IngestionDependencies,
  promotions: readonly CarriedCredit[],
): Promise<Transaction[]> {
  const promoted: Transaction[] = [];
  const originRows = new Map<string, readonly ImportRow[]>();
  for (const { leg, transaction } of promotions) {
    const edited = await editTransaction(deps, transaction.id, {
      unitPrice: transaction.unitPrice,
      status: 'active',
      preserveNaturalKey: true,
      flagUserModified: false,
    });
    if (!edited.ok) {
      throw new Error(`BR-005-20a: promoting a carried transfer failed: ${edited.error.code}`);
    }
    promoted.push(edited.value.transaction);

    // The row that first staged it leaves Needs attention, as classifying it would.
    const origin = leg.promotesFrom as ImportBatchId;
    const cached = originRows.get(origin);
    const originBatch = cached ?? (await deps.rows.listByBatch(origin));
    originRows.set(origin, originBatch);
    for (const row of originBatch) {
      if (row.transactionId === transaction.id && row.classification === 'unclassified') {
        await deps.rows.updateClassification(row.id, 'new');
      }
    }
  }
  return promoted;
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
  asOf: BusinessDate,
  positionRows: readonly ImportRow[],
  unclassifiedRows: readonly ImportRow[],
): Promise<ImportBatch['reconciliation']> {
  const unclassifiedAssetKeys = new Set(
    unclassifiedRows.map((row) => `${row.assetId}|${row.institutionId ?? ''}`),
  );

  // #108: the real Posição carries a `Conta` column, so one asset at one
  // institution can arrive as several rows, one per account. B3's figure for
  // the position is their sum. Compared row by row, every account would read
  // as a discrepancy against the whole ledger.
  const snapshots = new Map<string, { row: ImportRow; assetCode: string; b3Quantity: Quantity }>();
  for (const row of positionRows) {
    if (row.record.kind !== 'position') continue;
    const key = `${row.assetId}|${row.institutionId ?? ''}`;
    const seen = snapshots.get(key);
    snapshots.set(key, {
      row: seen?.row ?? row,
      assetCode: seen?.assetCode ?? row.record.assetCode,
      b3Quantity:
        seen === undefined ? row.record.quantity : seen.b3Quantity.plus(row.record.quantity),
    });
  }

  const inputs: ReconciliationInput[] = [];

  for (const { row, assetCode, b3Quantity } of snapshots.values()) {
    const existing = await deps.transactions.listForPosition(row.assetId, row.institutionId);
    const active = existing.filter((t) => t.status === 'active');
    const replayed = replayPosition(existing);
    // A ledger this reconciliation cannot replay is a defect upstream of it
    // (commit already refused to write anything unreplayable) — treated as
    // "nothing computed yet" rather than thrown, so one bad position never
    // blocks the reconciliation report for every other asset.
    const computedQuantity = replayed.ok ? replayed.value.quantity : b3Quantity;
    const firstComputedTradeDate = active.reduce<BusinessDate | null>(
      (min, t) => (min === null || t.tradeDate < min ? t.tradeDate : min),
      null,
    );

    inputs.push({
      assetId: row.assetId,
      assetCode,
      institutionId: row.institutionId,
      computedQuantity,
      b3Quantity,
      firstComputedTradeDate,
      hasUnclassifiedRowsAffectingAsset: unclassifiedAssetKeys.has(
        `${row.assetId}|${row.institutionId ?? ''}`,
      ),
    });
  }

  return reconcilePositions(asOf, inputs);
}
