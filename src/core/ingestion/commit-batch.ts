import { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import { TransactionId } from '@/core/shared/ids';
import type { ImportBatchId, ImportRowId, UserId } from '@/core/shared/ids';
import { type Quantity, asStored } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import { editTransactions } from '@/core/ledger/edit-transaction';
import {
  computeTotalValue,
  type Transaction,
  type TransactionType,
} from '@/core/ledger/transaction';
import { validateTransactionDraft } from '@/core/ledger/validate';
import {
  firstUnreplayable,
  type PositionKey,
  type PositionSnapshot,
  positionKeyString,
  replayPosition,
} from '@/core/positions/replay';
import { sortForReplay } from '@/core/positions/ordering';
import type { CorporateEventFactor } from '@/core/quotes/corporate-event-factors';
import type { PositionState } from '@/core/positions/position-state';
import type { IngestionDependencies } from '@/core/ingestion/dependencies';
import { ingestionError, IngestionUseCaseErrorCode } from '@/core/ingestion/errors';
import type { ImportBatch, ImportRow } from '@/core/ingestion/ports';
import { reconcilePositions, type ReconciliationInput } from '@/core/ingestion/reconcile';
import { corporateEventMovementOf, isIgnoredMovement } from '@/core/ingestion/movement-map';
import {
  type CorporateEventRow,
  type CorporateEventWindows,
  corporateEventMovementOfKey,
  resolveCorporateEvents,
} from '@/core/ingestion/corporate-event-resolution';
import { issuerCodeOf } from '@/core/ingestion/issuer-code';
import { keyFormsFor, summarizeRows } from '@/core/ingestion/stage-batch';
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
 * excluded from its insert and surfaced as `invalid`, rather than failing the
 * other 9.999 rows in the same commit. "Forgiving of user error" (the issue's
 * own framing) is why this reads BR-005-13 as per-row atomicity for that one
 * failure mode, not whole-batch.
 *
 * **#117 — only the rows at fault.** Until #117 the whole `(asset,
 * institution)` group was excluded, so one transfer debit with no holding
 * behind it discarded every provento of that asset. Now a failing group gives
 * up the row its replay stops at, one at a time (`refusedCandidates`), and the
 * rest of it applies. `invalid` rather than a stored `unclassified`
 * transaction: nothing is written, so no occurrence is taken, and importing
 * the file again once the earlier history is in applies the row (BR-005-17).
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
  /**
   * SPEC-005 BR-005-20b (#113) — the three corporate-event windows, resolved by
   * the caller from `import.corporate_event_factor_window_days`,
   * `import.fraction_origin_window_days` and `import.fraction_auction_window_days`
   * (SPEC-002: never a default in core).
   */
  readonly corporateEventWindows: CorporateEventWindows;
}

export interface CommitBatchOutcome {
  readonly batch: ImportBatch;
  readonly applied: number;
  /** BR-005-20a (#110): existing unclassified transfers this commit gave their carried cost. */
  readonly promoted: number;
  /** BR-005-20a (#112): existing carried transfers whose cost this commit recomputed to a new figure. */
  readonly recarried: number;
  /**
   * BR-005-17/18 (#110): rows an older map stored `unclassified` that this
   * map classifies, activated in place as that type.
   */
  readonly reclassified: number;
  /**
   * BR-005-19 (amended, #110): rows an older map stored `unclassified` that
   * mirror another extract's record, now `superseded`.
   */
  readonly superseded: number;
  readonly skippedDuplicates: number;
  readonly invalid: number;
  /**
   * BR-005-20b (#113): corporate-event rows this commit applied — Desdobro and
   * Grupamento as `split`/`grupamento`, Fração em Ativos as `fracao_bonificacao`
   * or `sell`, Leilão de Fração as `leilao_fracoes` — inserted, or activated in
   * place when an earlier import stored them `unclassified`.
   */
  readonly resolvedCorporateEvents: number;
  /** BR-005-19 (amended, #113): Leilão de Fração rows consumed by a split or grupamento fraction sale, now `superseded`. */
  readonly consumedAuctions: number;
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

/**
 * A carry leg with the row it came from, and what carrying it writes:
 *
 * - `insert` — a price-less row staged `unclassified` in this batch;
 * - `promote` (#110) — a duplicate of an existing unclassified transfer, which
 *   becomes active at the carried cost; `origin` is the batch that staged it;
 * - `recarry` (#112) — a duplicate of an existing carried transfer no one has
 *   edited, whose cost is recomputed and updated when the figure changed.
 */
interface PlannedCarry extends CarryLeg {
  readonly row: ImportRow;
  readonly mode: 'insert' | 'promote' | 'recarry';
  readonly origin: ImportBatchId | null;
}

interface CarriedCredit {
  readonly leg: PlannedCarry;
  readonly transaction: Transaction;
}

/**
 * SPEC-005 BR-005-20b (#113) — a corporate-event row as commit sees it, and what
 * resolving it writes:
 *
 * - `insert` — this batch's own `unclassified` row, never stored: inserted
 *   active (or `superseded`, when consumed) under its staged key and occurrence;
 * - `in_place` — a `duplicate` whose stored copy an earlier import left
 *   `unclassified` and no one touched: activated (or superseded) in place, key
 *   kept, not a user edit (BR-005-20); `origin` is the batch that staged it;
 * - `partner` — a stored copy this commit may not modify: resolved already,
 *   classified by hand, or `unclassified` from a file not in this import.
 */
interface PlannedCorporateRow {
  readonly event: CorporateEventRow;
  readonly row: ImportRow | null;
  readonly mode: 'insert' | 'in_place' | 'partner';
  readonly origin: ImportBatchId | null;
}

interface CorporatePlan {
  readonly rows: readonly PlannedCorporateRow[];
  readonly byId: ReadonlyMap<string, PlannedCorporateRow>;
  readonly factors: ReadonlyMap<string, readonly CorporateEventFactor[]>;
  readonly windows: CorporateEventWindows;
}

/** A resolved corporate-event row in a settling round, and what it writes. */
interface CorporateWrite {
  readonly planned: PlannedCorporateRow;
  readonly status: 'resolved' | 'consumed';
  readonly transaction: Transaction;
}

interface Group {
  readonly key: PositionKey;
  readonly candidates: Candidate[];
  readonly carried: CarriedCredit[];
  readonly reclassified: Reclassification[];
  readonly corporate: CorporateWrite[];
  /** What the group's replay folded: stored ledger plus this commit's rows. */
  readonly ledger: readonly Transaction[];
  /**
   * #117 review — a credit into this position has a live debit whose cost did
   * not resolve this round, so the position may replay once its source does.
   */
  readonly waitsForCarry: boolean;
  readonly state: PositionState | null;
}

/**
 * #117 — the types that take shares out of a position (`adjustment` when
 * negative, `grupamento` when it groups, `fracao_bonificacao` always — SPEC-007
 * BR-007-05a). Removing one only raises the quantity every later row sees, so
 * when a replay stops at a stored row the staged disposal nearest before it is
 * the row to refuse.
 */
const DISPOSALS: ReadonlySet<TransactionType> = new Set<TransactionType>([
  'sell',
  'transfer_out',
  'grupamento',
  'adjustment',
  'fracao_bonificacao',
]);

/**
 * SPEC-005 BR-005-17..19 (#110) — an existing `unclassified` transaction an
 * older map version stored, which the staged duplicate of the same B3 row now
 * classifies: `activate` as its mapped type, or `supersede` as a mirror.
 * `origin` is the batch whose row staged it.
 */
interface Reclassification {
  readonly row: ImportRow;
  readonly kind: 'activate' | 'supersede';
  readonly updated: Transaction;
  readonly origin: ImportBatchId;
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
      recarried: 0,
      reclassified: 0,
      superseded: 0,
      skippedDuplicates: 0,
      invalid: 0,
      resolvedCorporateEvents: 0,
      consumedAuctions: 0,
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
   *
   * An exclusion is never reconsidered, which is what keeps the rounds
   * monotonic. So a destination whose carry is still unresolved (`waitsForCarry`)
   * is not judged while another failed group can be: excluding a row at the
   * source may resolve the carry next round and let the destination replay
   * (#117 review). Only when every failed group waits are they judged anyway.
   */
  const excluded = new Set<string>();
  const vetoed = new Set<string>();
  const declined = new Set<string>();
  const reclassifications = planReclassifications(rows, stored, carryLegs, today);
  const corporate = await planCorporateEvents(
    deps,
    rows,
    stored,
    { batchId: batch.id, userId, now, today },
    input.corporateEventWindows,
  );
  /** BR-005-20b: resolved corporate-event rows given up because their group could not replay with them. */
  const corporateDeclined = new Set<string>();
  const settleRound = () =>
    settle(
      newCandidates,
      carryLegs,
      reclassifications,
      stored,
      excluded,
      vetoed,
      declined,
      corporate,
      corporateDeclined,
    );
  let settlement = settleRound();
  for (
    let failed = settlement.filter((group) => group.state === null);
    failed.length > 0;
    failed = settlement.filter((group) => group.state === null)
  ) {
    const ready = failed.filter((group) => !group.waitsForCarry);
    for (const group of ready.length > 0 ? ready : failed) {
      // #110: an older import's row that no longer replays as its mapped type
      // (a `Resgate` sell of shares the ledger never held) is given up first.
      // It stays `unclassified`, exactly as it was, and the batch keeps its own
      // rows — the owner's file must import (BR-005-19).
      if (group.reclassified.length > 0) {
        for (const r of group.reclassified) declined.add(r.row.id);
        continue;
      }
      // #113 BR-005-20b: then a corporate event this commit resolved — the one
      // the replay stops at, or the nearest before it (a grupamento that leaves
      // a later stored sale short). It stays `unclassified`; the next round
      // refuses it `conflicts_with_ledger` and re-walks what depends on it.
      const culprit = corporateCulprit(group);
      if (culprit !== undefined) {
        corporateDeclined.add(culprit);
        continue;
      }
      // #117 BR-006-15: only the rows the replay cannot accept are excluded
      // (never written, surfaced as `invalid`); the group's proventos and every
      // other row still apply.
      const refused = refusedCandidates(group);
      if (refused.length > 0) {
        for (const c of refused) excluded.add(c.row.id);
        continue;
      }
      // Nothing of this batch explains it — the stored ledger fails on its own,
      // which the write path never lets happen: every `new` row in the group is
      // excluded, and a carried credit in it falls back to `unclassified`.
      for (const c of group.candidates) excluded.add(c.row.id);
      for (const c of group.carried) vetoed.add(c.leg.id);
    }
    settlement = settleRound();
  }
  for (const c of newCandidates) if (excluded.has(c.row.id)) invalidRowIds.push(c.row.id);

  const toInsert: Transaction[] = [];
  const positionUpserts: PositionSnapshot[] = [];
  const rowToTransaction = new Map<ImportRowId, TransactionId>();
  const carriedRowIds = new Set<ImportRowId>();
  const inPlace: CarriedCredit[] = [];
  const reclassified: Reclassification[] = [];
  /** BR-005-20b: this batch's own corporate-event rows, written resolved (`new`) or consumed (`ignored`). */
  const corporateRowClassification = new Map<ImportRowId, 'new' | 'ignored'>();
  const supersededInserts: Transaction[] = [];
  const corporateInPlace: Reclassification[] = [];

  for (const group of settlement) {
    // Every group left in the final round replayed.
    if (group.state === null) continue;
    for (const c of group.candidates) {
      toInsert.push(c.transaction);
      rowToTransaction.set(c.row.id, c.transaction.id);
    }
    for (const c of group.carried) {
      if (c.leg.mode !== 'insert') {
        inPlace.push(c);
        continue;
      }
      toInsert.push(c.transaction);
      rowToTransaction.set(c.leg.row.id, c.transaction.id);
      carriedRowIds.add(c.leg.row.id);
    }
    reclassified.push(...group.reclassified);
    for (const write of group.corporate) {
      const { planned, status, transaction } = write;
      if (planned.mode === 'in_place') {
        corporateInPlace.push({
          row: planned.row as ImportRow,
          kind: status === 'resolved' ? 'activate' : 'supersede',
          updated: transaction,
          origin: planned.origin as ImportBatchId,
        });
        continue;
      }
      // `insert`: a consumed Leilão is still inserted, `superseded`, so its
      // occurrence is taken and a re-import stages it a duplicate (BR-005-17).
      const row = planned.row as ImportRow;
      if (status === 'resolved') toInsert.push(transaction);
      else supersededInserts.push(transaction);
      rowToTransaction.set(row.id, transaction.id);
      corporateRowClassification.set(row.id, status === 'resolved' ? 'new' : 'ignored');
    }
    // A group holding only superseded rows changed no figure: nothing to write.
    const changesPosition =
      group.candidates.length > 0 ||
      group.carried.length > 0 ||
      group.reclassified.some((r) => r.kind === 'activate') ||
      group.corporate.some((c) => c.status === 'resolved');
    if (changesPosition) positionUpserts.push({ ...group.key, state: group.state });
  }

  // `unclassified` rows are excluded from replay by `status`
  // (`selectForReplay`, SPEC-007), so they can never make a position
  // unreplayable and never need the group check above.
  for (const row of unclassifiedRows) {
    if (carriedRowIds.has(row.id) || corporateRowClassification.has(row.id)) continue;
    const transaction =
      corporate.byId.get(row.id)?.event.transaction ??
      buildCandidate(row, batch.id, userId, 'unclassified', now, today);
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
  if (toInsert.length + supersededInserts.length > 0) {
    await deps.transactions.insertMany([...toInsert, ...supersededInserts]);
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
  // BR-005-19/20b: nor does a resolved or consumed corporate-event row.
  for (const [rowId, classification] of corporateRowClassification) {
    await deps.rows.updateClassification(rowId, classification);
  }

  const { promoted, recarried, activated, superseded } = await updateInPlace(deps, inPlace, [
    ...reclassified,
    ...reclassifications.filter((r) => r.kind === 'supersede'),
    ...corporateInPlace,
  ]);
  const corporateIds = new Set<string>(corporateInPlace.map((r) => r.updated.id));
  const isCorporate = (t: Transaction) => corporateIds.has(t.id);

  await settleEarlierRefusals(deps, batch.id, toInsert);

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
  const reconciliation = asOf !== null ? await buildReconciliation(deps, asOf, positionRows) : null;

  const committedBatch: ImportBatch = {
    ...batch,
    status: 'committed',
    committedAt: now,
    reconciliation,
    // BR-005-10: the preview counted a carried credit as needing attention and
    // a refused row (#117) as new; the committed batch reports what each became.
    rowCounts:
      batch.rowCounts === null
        ? null
        : summarizeRows(batch.rowCounts.read, await deps.rows.listByBatch(batch.id)),
  };
  await deps.batches.update(committedBatch);

  return ok({
    batch: committedBatch,
    applied: toInsert.length,
    promoted: promoted.length,
    recarried: recarried.length,
    reclassified: activated.filter((t) => !isCorporate(t)).length,
    superseded: superseded.filter((t) => !isCorporate(t)).length,
    skippedDuplicates: duplicates.length,
    invalid: invalidRowIds.length,
    resolvedCorporateEvents:
      corporateRowClassification.size -
      supersededInserts.length +
      activated.filter(isCorporate).length,
    consumedAuctions: supersededInserts.length + superseded.filter(isCorporate).length,
    // Superseded rows are left out: they enter no calculation (BR-006-03).
    committed: [...toInsert, ...promoted, ...recarried, ...activated],
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
    if (row.record.kind !== 'transaction') continue;
    const touches =
      row.classification === 'new' ||
      row.classification === 'duplicate' ||
      row.ledgerType === 'transfer_in' ||
      row.ledgerType === 'transfer_out' ||
      // #113 BR-005-20b: a staged corporate-event row resolves against its position.
      corporateEventMovementOf(row.record.b3Type) !== null;
    if (!touches) continue;
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
 * SPEC-005 BR-005-17..19 (#110) — duplicates whose stored copy an older map
 * version left `unclassified`, and what this map makes of them.
 *
 * The owner's first real Movimentação was committed before map v3: 684 mirror
 * rows and 13 rows v3 now maps were stored as `unclassified` transactions.
 * Re-importing the file counted them as duplicates (BR-005-17's key forms) and
 * did nothing else, so they stayed in Needs attention for good.
 *
 * **Finding the stored copy.** `ImportRow` persists one key, the one staging
 * chose. A mirror row is staged under the same key an older map stored it
 * with (placeholder type plus raw B3 type), so it is looked up by that key. A
 * row this map classifies is staged under the `mapped` form, and its stored
 * copy sits under the `unmapped` form — rebuilt here from the row's own fields
 * with `keyFormsFor`, the function staging counts forms with. Same occurrence
 * on both sides; a copy under another ordinal is not guessed at.
 *
 * Only a copy no human decided is touched: `unclassified`, not user-modified,
 * imported (BR-006-16). A row staged price-less or as a carry candidate is
 * not activated here — the carry owns it (BR-005-20a).
 */
function planReclassifications(
  rows: readonly ImportRow[],
  stored: StoredLedger,
  carryLegs: readonly PlannedCarry[],
  today: BusinessDate,
): readonly Reclassification[] {
  const taken = new Set<string>(carryLegs.map((leg) => leg.credit.id));
  const planned: Reclassification[] = [];
  for (const row of rows) {
    if (
      row.classification !== 'duplicate' ||
      row.record.kind !== 'transaction' ||
      row.naturalKey === null ||
      row.ledgerType === null
    ) {
      continue;
    }
    const record = row.record;
    const mirror = isIgnoredMovement(record.b3Type);
    let storedKey = row.naturalKey;
    if (!mirror) {
      if (isCarryCandidate(row)) continue;
      const forms = keyFormsFor(
        {
          assetId: row.assetId,
          institutionId: row.institutionId,
          tradeDate: record.tradeDate,
          quantity: record.quantity,
          unitPrice: record.unitPrice,
        },
        row.ledgerType,
        record.b3Type,
      );
      // Still unmapped, or mapped but staged for want of a price: nothing to activate.
      if (row.naturalKey !== forms.mapped) continue;
      storedKey = forms.unmapped;
    }

    const copy = stored(row).find(
      (t) =>
        t.naturalKey === storedKey &&
        t.occurrence === row.occurrence &&
        t.status === 'unclassified' &&
        !t.isUserModified &&
        !t.isManual &&
        t.importBatchId !== null &&
        !taken.has(t.id),
    );
    if (copy === undefined) continue;

    const updated: Transaction = mirror
      ? { ...copy, status: 'superseded' }
      : {
          ...copy,
          type: row.ledgerType,
          status: 'active',
          ratio: record.ratio,
          totalValue: computeTotalValue(row.ledgerType, copy.quantity, copy.unitPrice, copy.fees),
        };
    if (
      !mirror &&
      !validateTransactionDraft(
        {
          type: updated.type,
          tradeDate: updated.tradeDate,
          quantity: updated.quantity,
          unitPrice: updated.unitPrice,
          fees: updated.fees,
          ratio: updated.ratio,
        },
        today,
      ).ok
    ) {
      continue;
    }

    taken.add(copy.id);
    planned.push({
      row,
      kind: mirror ? 'supersede' : 'activate',
      updated,
      origin: copy.importBatchId as ImportBatchId,
    });
  }
  return planned;
}

/**
 * BR-005-20a — the credits that can take a carried cost in this commit, each
 * with the debit it is paired with (`pairTransfers`).
 *
 * A credit is a price-less row staged `unclassified`, or — import order must
 * not decide the outcome — a `duplicate` of an **existing** `transfer_in` no
 * one has edited (BR-006-16):
 *
 * - unclassified (#110): the same B3 row, imported before its source's history
 *   was, now able to take its cost;
 * - active (#112): a cost carried by an earlier import, recomputed because the
 *   source's history may have grown since — a buy imported after the transfer
 *   changes the average the shares left with.
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
    let mode: PlannedCarry['mode'] = 'insert';
    let origin: ImportBatchId | null = null;
    if (creditRow.classification === 'unclassified') {
      credit = buildCandidate(creditRow, batchId, userId, 'active', now, today);
    } else if (creditRow.classification === 'duplicate') {
      const existing = storedCopyOf(stored, creditRow);
      if (
        existing !== undefined &&
        existing.type === 'transfer_in' &&
        !existing.isUserModified &&
        existing.importBatchId !== null
      ) {
        if (existing.status === 'unclassified') {
          credit = { ...existing, status: 'active' };
          mode = 'promote';
          origin = existing.importBatchId;
        } else if (existing.status === 'active') {
          credit = existing;
          mode = 'recarry';
        }
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

    planned.push({
      id: creditId,
      row: creditRow,
      credit,
      debit,
      fallback: mode === 'recarry' ? credit.unitPrice : null,
      mode,
      origin,
    });
  }
  return planned;
}

/** One settling round: resolve carries against what is not excluded, then replay every group. */
function settle(
  newCandidates: readonly Candidate[],
  carryLegs: readonly PlannedCarry[],
  reclassifications: readonly Reclassification[],
  stored: StoredLedger,
  excluded: ReadonlySet<string>,
  vetoed: ReadonlySet<string>,
  declined: ReadonlySet<string>,
  corporate: CorporatePlan,
  corporateDeclined: ReadonlySet<string>,
): Group[] {
  const live = newCandidates.filter((c) => !excluded.has(c.row.id));
  const liveReclassified = reclassifications.filter((r) => !declined.has(r.row.id));
  const excludedTransactions = new Set<string>(
    newCandidates.filter((c) => excluded.has(c.row.id)).map((c) => c.transaction.id),
  );
  const legs = carryLegs
    .filter((leg) => !vetoed.has(leg.id))
    .map((leg) => ({
      ...leg,
      debit: leg.debit !== null && excludedTransactions.has(leg.debit.id) ? null : leg.debit,
    }));

  // A promoted or re-carried credit is stored too; its stored self leaves the
  // source history while it is a leg, so it is never counted twice.
  const legCredits = new Set<string>(legs.map((leg) => leg.credit.id));
  const costs = resolveCarriedCosts(legs, (assetId, institutionId) => [
    ...stored({ assetId, institutionId }).filter((t) => !legCredits.has(t.id)),
    ...live
      .filter((c) => c.row.assetId === assetId && c.row.institutionId === institutionId)
      .map((c) => c.transaction),
    // An activated row is part of the source's history, as it would have been
    // had the older map known its type.
    ...liveReclassified
      .filter(
        (r) =>
          r.kind === 'activate' &&
          r.updated.assetId === assetId &&
          r.updated.institutionId === institutionId,
      )
      .map((r) => r.updated),
  ]);
  const waiting = new Set<string>(
    legs
      .filter((leg) => leg.debit !== null && !costs.has(leg.id))
      .map((leg) => positionKeyString(leg.credit)),
  );

  const groups = new Map<
    string,
    {
      key: PositionKey;
      candidates: Candidate[];
      carried: CarriedCredit[];
      reclassified: Reclassification[];
      corporate: CorporateWrite[];
    }
  >();
  const groupOf = (key: PositionKey) => {
    const id = positionKeyString(key);
    const existing = groups.get(id);
    if (existing !== undefined) return existing;
    const created = {
      key: { assetId: key.assetId, institutionId: key.institutionId },
      candidates: [],
      carried: [],
      reclassified: [],
      corporate: [],
    };
    groups.set(id, created);
    return created;
  };
  for (const c of live) groupOf(c.transaction).candidates.push(c);
  for (const leg of legs) {
    const cost = costs.get(leg.id);
    if (cost === undefined) continue;
    // #112: a re-carry that lands on the figure already stored writes nothing.
    // Compared at the column's scale (`asStored`): a repeating average is kept
    // to 8 places, so the full-precision figure would never equal it and every
    // re-import of the same file would rewrite the transfer and rebuild history.
    if (leg.mode === 'recarry' && asStored(cost) === asStored(leg.credit.unitPrice)) continue;
    groupOf(leg.credit).carried.push({ leg, transaction: withCarriedCost(leg.credit, cost) });
  }
  // Only an activation enters a replay; a superseded row was never in one.
  for (const r of liveReclassified) {
    if (r.kind === 'activate') groupOf(r.updated).reclassified.push(r);
  }
  const replaced = new Set<string>(
    [...groups.values()].flatMap((group) => [
      ...group.carried.map((c) => c.transaction.id),
      ...group.reclassified.map((r) => r.updated.id),
    ]),
  );

  /**
   * SPEC-005 BR-005-20b (#113) — corporate events, after carries and before
   * replay, every round: each position's history is what this round writes for
   * it (live rows, carried credits, activations) over the stored ledger, so a
   * Desdobro's P includes a same-batch buy and a carried transfer in.
   */
  if (corporate.rows.length > 0) {
    const outcomes = resolveCorporateEvents({
      rows: corporate.rows.map((planned) => planned.event),
      history: (key) => {
        const group = groups.get(positionKeyString(key));
        return [
          ...stored(key).filter((t) => !replaced.has(t.id)),
          ...(group === undefined
            ? []
            : [
                ...group.candidates.map((c) => c.transaction),
                ...group.carried.map((c) => c.transaction),
                ...group.reclassified.map((r) => r.updated),
              ]),
        ];
      },
      factors: corporate.factors,
      windows: corporate.windows,
      declined: corporateDeclined,
    });
    for (const [id, outcome] of outcomes) {
      if (outcome.status === 'refused') continue;
      groupOf(outcome.transaction).corporate.push({
        planned: corporate.byId.get(id) as PlannedCorporateRow,
        status: outcome.status,
        transaction: outcome.transaction,
      });
      replaced.add(outcome.transaction.id);
    }
  }

  return [...groups.values()].map((group) => {
    const ledger = [
      ...stored(group.key).filter((t) => !replaced.has(t.id)),
      ...group.candidates.map((c) => c.transaction),
      ...group.carried.map((c) => c.transaction),
      ...group.reclassified.map((r) => r.updated),
      ...group.corporate.map((c) => c.transaction),
    ];
    const replayed = replayPosition(ledger);
    return {
      ...group,
      ledger,
      waitsForCarry: waiting.has(positionKeyString(group.key)),
      state: replayed.ok ? replayed.value : null,
    };
  });
}

/**
 * SPEC-005 BR-005-20b (#113) — every corporate-event row this commit can
 * resolve or pair with, and the published factors their issuers have.
 *
 * - A staged `unclassified` row of a corporate-event B3 type is `open`,
 *   written by `insert`; its unclassified transaction is built once here, so a
 *   row that stays unclassified is inserted with the same id.
 * - A `duplicate` whose stored copy is `unclassified`, imported and untouched
 *   (BR-006-16) is `open`, written `in_place`. Any other stored copy — resolved
 *   by an earlier import, classified by hand — is a `partner`, never modified.
 * - A stored corporate-event row on the same position that this file does not
 *   carry is a `partner` too: it takes part in pairing and blocks what it
 *   should (Decision log row 11: pairing within one import plus the ledger).
 *
 * Factors are read once, through the shared-table reader (SPEC-008 BR-008-29):
 * an issuer with none, or a reader that has none, leaves its rows unconfirmed.
 */
async function planCorporateEvents(
  deps: IngestionDependencies,
  rows: readonly ImportRow[],
  stored: StoredLedger,
  context: { batchId: ImportBatchId; userId: UserId; now: Date; today: BusinessDate },
  windows: CorporateEventWindows,
): Promise<CorporatePlan> {
  const planned: PlannedCorporateRow[] = [];
  const represented = new Set<string>();
  const tickers = new Map<string, string>();
  for (const row of rows) {
    if (row.record.kind !== 'transaction') continue;
    const movement = corporateEventMovementOf(row.record.b3Type);
    if (movement === null) continue;
    const ticker = row.record.assetCode;
    tickers.set(positionKeyString(row), ticker);
    if (row.classification === 'unclassified') {
      const transaction = buildCandidate(
        row,
        context.batchId,
        context.userId,
        'unclassified',
        context.now,
        context.today,
      );
      if (transaction === null) continue;
      planned.push({
        event: { id: row.id, movement, ticker, transaction, open: true },
        row,
        mode: 'insert',
        origin: null,
      });
      continue;
    }
    if (row.classification !== 'duplicate') continue;
    const copy = storedCopyOf(stored, row);
    if (copy === undefined) continue;
    represented.add(copy.id);
    const open =
      copy.status === 'unclassified' &&
      !copy.isUserModified &&
      !copy.isManual &&
      copy.importBatchId !== null;
    planned.push({
      event: { id: row.id, movement, ticker, transaction: copy, open },
      row,
      mode: open ? 'in_place' : 'partner',
      origin: copy.importBatchId,
    });
  }

  const positions = new Map<string, PositionKey>(
    planned.map((p) => [positionKeyString(p.event.transaction), p.event.transaction]),
  );
  for (const [id, key] of positions) {
    for (const t of stored(key)) {
      const movement = corporateEventMovementOfKey(t.naturalKey);
      if (movement === null || represented.has(t.id)) continue;
      planned.push({
        event: {
          id: t.id,
          movement,
          ticker: tickers.get(id) as string,
          transaction: t,
          open: false,
        },
        row: null,
        mode: 'partner',
        origin: t.importBatchId,
      });
    }
  }

  const issuers = [
    ...new Set(
      planned
        .filter((p) => p.event.movement === 'desdobro' || p.event.movement === 'grupamento')
        .flatMap((p) => {
          const code = issuerCodeOf(p.event.ticker);
          return code === null ? [] : [code];
        }),
    ),
  ];
  const factors =
    issuers.length === 0 ? new Map() : await deps.corporateEventFactors.listByIssuers(issuers);

  return {
    rows: planned,
    byId: new Map(planned.map((p) => [p.event.id, p])),
    factors,
    windows,
  };
}

/**
 * #113 BR-005-20b — the resolved corporate event of a failed group to give up:
 * the row its replay stops at, or the nearest resolved one before it in replay
 * order. `undefined` when none precedes the failure — then it is not theirs.
 */
function corporateCulprit(group: Group): string | undefined {
  const resolved = new Map(
    group.corporate
      .filter((c) => c.status === 'resolved')
      .map((c) => [c.transaction.id as string, c.planned.event.id]),
  );
  if (resolved.size === 0) return undefined;
  const failure = firstUnreplayable(group.ledger);
  if (failure === null) return undefined;
  const ordered = sortForReplay(group.ledger);
  for (let i = ordered.findIndex((t) => t.id === failure.transaction.id); i >= 0; i -= 1) {
    const id = resolved.get((ordered[i] as Transaction).id);
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * #117 — the candidates of a failed group its replay cannot accept, in replay
 * order. The fold's failing row is set aside when this batch staged it; when
 * it is stored, the staged disposal nearest before it is (`disposalBefore`).
 * The fold runs again until it completes, or until nothing staged explains the
 * failure.
 *
 * Replayed here against the group alone, so a group with many refusals costs
 * one settling round rather than one per refusal.
 */
function refusedCandidates(group: Group): readonly Candidate[] {
  const byTransaction = new Map(group.candidates.map((c) => [c.transaction.id, c]));
  const refused: Candidate[] = [];
  let ledger = group.ledger;
  for (
    let failure = firstUnreplayable(ledger);
    failure !== null;
    failure = firstUnreplayable(ledger)
  ) {
    const culprit =
      byTransaction.get(failure.transaction.id) ??
      disposalBefore(ledger, failure.transaction, byTransaction);
    if (culprit === undefined) break;
    refused.push(culprit);
    const id = culprit.transaction.id;
    ledger = ledger.filter((t) => t.id !== id);
  }
  return refused;
}

function disposalBefore(
  ledger: readonly Transaction[],
  failing: Transaction,
  byTransaction: ReadonlyMap<string, Candidate>,
): Candidate | undefined {
  const ordered = sortForReplay(ledger);
  for (let i = ordered.findIndex((t) => t.id === failing.id) - 1; i >= 0; i -= 1) {
    const candidate = byTransaction.get((ordered[i] as Transaction).id);
    if (candidate !== undefined && DISPOSALS.has(candidate.transaction.type)) return candidate;
  }
  return undefined;
}

/**
 * #117 / BR-005-17 — rows an earlier commit refused (`invalid`) that this
 * commit applied under the same key and occurrence are now in the ledger: each
 * becomes a `duplicate`, leaves Needs attention, and its batch is recounted.
 * Before #117 that was also every provento of a refused group, stored `invalid`
 * on each import of the same file.
 */
async function settleEarlierRefusals(
  deps: IngestionDependencies,
  batchId: ImportBatchId,
  applied: readonly Transaction[],
): Promise<void> {
  if (applied.length === 0) return;
  const appliedKeys = new Set(applied.map((t) => `${t.naturalKey}#${t.occurrence}`));
  const earlier = (
    await deps.rows.listInvalidByNaturalKeys(applied.map((t) => t.naturalKey))
  ).filter(
    (row) => row.batchId !== batchId && appliedKeys.has(`${row.naturalKey}#${row.occurrence}`),
  );
  const batches = new Set<ImportBatchId>();
  for (const row of earlier) {
    await deps.rows.updateClassification(row.id, 'duplicate');
    batches.add(row.batchId);
  }
  for (const id of batches) {
    const origin = await deps.batches.findById(id);
    if (origin === null || origin.rowCounts === null) continue;
    await deps.batches.update({
      ...origin,
      rowCounts: summarizeRows(origin.rowCounts.read, await deps.rows.listByBatch(id)),
    });
  }
}

/**
 * BR-005-20a (#110, #112) — existing transfers take their carried cost in
 * place: the same B3 row gaining information, not a new row, so the key is kept
 * (BR-005-17) and the row is not badged as a user's edit (BR-006-16).
 *
 * **All of them in one `editTransactions` call**, so BR-006-15's guard replays
 * each position once with every update in it. Two transfers promoted into one
 * position that a later transfer out needs both of are valid only together;
 * edited one at a time, the first was refused and the batch could never commit.
 *
 * The settling round already replayed these ledgers, so a refusal here is a
 * defect, not a user error — thrown, so the whole commit rolls back
 * (BR-005-13) rather than leaving positions written for updates that never
 * happened.
 */
interface InPlaceOutcome {
  readonly promoted: Transaction[];
  readonly recarried: Transaction[];
  readonly activated: Transaction[];
  readonly superseded: Transaction[];
}

/**
 * #110 — every in-place update of this commit that enters a calculation —
 * promoted and re-carried transfers, activated rows — in the one
 * `editTransactions` call, so BR-006-15's guard and the recalculation run once
 * per position with all of them in place.
 *
 * A superseded row is written directly instead. `unclassified` → `superseded`
 * changes no replay input (both are excluded by `selectForReplay`), so there is
 * nothing for the guard to refuse, and recalculating would cache an empty
 * position for an asset the ledger holds nothing active of — one a rebuild
 * never produces (DM-4).
 */
async function updateInPlace(
  deps: IngestionDependencies,
  carried: readonly CarriedCredit[],
  reclassifications: readonly Reclassification[],
): Promise<InPlaceOutcome> {
  const outcome: InPlaceOutcome = { promoted: [], recarried: [], activated: [], superseded: [] };
  const reclassified = reclassifications.filter((r) => r.kind === 'activate');
  const supersedes = reclassifications.filter((r) => r.kind === 'supersede');
  if (carried.length === 0 && reclassifications.length === 0) return outcome;

  const edited = await editTransactions(deps, [
    ...carried.map(({ transaction }) => ({
      id: transaction.id,
      input: {
        unitPrice: transaction.unitPrice,
        status: 'active' as const,
        preserveNaturalKey: true,
        flagUserModified: false,
      },
    })),
    ...reclassified.map(({ updated }) => ({
      id: updated.id,
      input: {
        type: updated.type,
        status: updated.status,
        ratio: updated.ratio,
        // #113 BR-007-04b: a split fraction's sale takes its auction's price
        // (`applyEdit` recomputes the total). Every other activation keeps its own.
        unitPrice: updated.unitPrice,
        preserveNaturalKey: true,
        flagUserModified: false,
      },
    })),
  ]);
  if (!edited.ok) {
    throw new Error(`SPEC-005 #110: in-place import updates failed: ${edited.error.code}`);
  }

  // What each origin row becomes: `new` once it enters calculations, `ignored`
  // once it is known to mirror another extract (BR-005-19).
  const originRows = new Map<ImportBatchId, Map<string, 'new' | 'ignored'>>();
  const mark = (origin: ImportBatchId, id: string, next: 'new' | 'ignored') => {
    originRows.set(origin, (originRows.get(origin) ?? new Map()).set(id, next));
  };
  edited.value.transactions.forEach((transaction, index) => {
    if (index < carried.length) {
      const { leg } = carried[index] as CarriedCredit;
      if (leg.mode === 'recarry') {
        outcome.recarried.push(transaction);
        return;
      }
      outcome.promoted.push(transaction);
      mark(leg.origin as ImportBatchId, transaction.id, 'new');
      return;
    }
    const r = reclassified[index - carried.length] as Reclassification;
    outcome.activated.push(transaction);
    mark(r.origin, transaction.id, 'new');
  });
  for (const r of supersedes) {
    const superseded: Transaction = { ...r.updated, updatedAt: deps.clock.now() };
    await deps.transactions.update(superseded);
    outcome.superseded.push(superseded);
    mark(r.origin, superseded.id, 'ignored');
  }

  // The row that first staged each one leaves Needs attention, and its batch's
  // stored counts say so (BR-005-10).
  for (const [origin, marks] of originRows) {
    let toNew = 0;
    let toIgnored = 0;
    for (const row of await deps.rows.listByBatch(origin)) {
      const next = row.transactionId === null ? undefined : marks.get(row.transactionId);
      if (next === undefined || row.classification !== 'unclassified') continue;
      await deps.rows.updateClassification(row.id, next);
      if (next === 'new') toNew += 1;
      else toIgnored += 1;
    }
    const originBatch = await deps.batches.findById(origin);
    if (originBatch === null || originBatch.rowCounts === null || toNew + toIgnored === 0) {
      continue;
    }
    const counts = originBatch.rowCounts;
    await deps.batches.update({
      ...originBatch,
      rowCounts: {
        ...counts,
        new: counts.new + toNew,
        ignored: counts.ignored + toIgnored,
        needsAttention: counts.needsAttention - toNew - toIgnored,
      },
    });
  }

  return outcome;
}

/** `null` when the row's own fields fail `validateTransactionDraft` — a corrupt or contradictory extract row. */
export function buildCandidate(
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
): Promise<ImportBatch['reconciliation']> {
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
      // SPEC-005 BR-005-24 (amended, #113): the ledger's own `unclassified`
      // transactions on the position. A Posição batch never holds unclassified
      // rows, so reading its rows could never give this cause — a Desdobro
      // still unclassified read as missing history.
      hasUnclassifiedRowsAffectingAsset: existing.some((t) => t.status === 'unclassified'),
    });
  }

  return reconcilePositions(asOf, inputs);
}
