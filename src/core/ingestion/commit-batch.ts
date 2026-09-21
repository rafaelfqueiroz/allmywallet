import { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import { ConversionGroupId, TransactionId } from '@/core/shared/ids';
import type { ImportBatchId, ImportRowId, UserId } from '@/core/shared/ids';
import { Money, Quantity, asStored } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import { editTransactions } from '@/core/ledger/edit-transaction';
import { validateAssetConversionGroup } from '@/core/ledger/manage-asset-conversion';
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
  type ReplayFailure,
  replayPosition,
} from '@/core/positions/replay';
import { sortForReplay } from '@/core/positions/ordering';
import type { CorporateEventFactor } from '@/core/quotes/corporate-event-factors';
import type { PositionState } from '@/core/positions/position-state';
import type { IngestionDependencies } from '@/core/ingestion/dependencies';
import { ingestionError, IngestionUseCaseErrorCode } from '@/core/ingestion/errors';
import type { ImportBatch, ImportRow } from '@/core/ingestion/ports';
import { reconcilePositions, type ReconciliationInput } from '@/core/ingestion/reconcile';
import {
  conversionEvidenceMovementOf,
  corporateEventMovementOf,
  isIgnoredMovement,
  normalizeMovementType,
} from '@/core/ingestion/movement-map';
import {
  ASSET_CONVERSION_DEFINITIONS,
  ASSET_LIQUIDATION_DEFINITIONS,
  type AssetConversionDefinition,
  type AssetLiquidationDefinition,
} from '@/core/ingestion/asset-conversion-definitions';
import {
  type LiquidationEvidence,
  liquidationGroupKey,
  resolveLiquidation,
} from '@/core/ingestion/asset-liquidation-resolution';
import {
  type AssetConversionEvidence,
  corroboratesSourceBalance,
  resolveAssetConversion,
} from '@/core/ingestion/asset-conversion-resolution';
import {
  type CorporateEventOutcome,
  type CorporateEventRow,
  type CorporateEventWindows,
  corporateEventMovementOfKey,
  resolveCorporateEvents,
} from '@/core/ingestion/corporate-event-resolution';
import { issuerCodeOf } from '@/core/ingestion/issuer-code';
import { keyFormsFor, summarizeRows } from '@/core/ingestion/stage-batch';
import {
  type CarryLeg,
  debitsHeldBack,
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
  /** SPEC-005 BR-005-20c: resolved by the caller from SPEC-002. */
  readonly assetConversionWindowDays: number;
  /** AR-69: personal upgrades enable new ledger values only after health succeeds. */
  readonly assetConversionsEnabled: boolean;
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
  /** BR-005-20c: complete conversion groups resolved by this commit. */
  readonly resolvedAssetConversions: number;
  /** BR-005-20c: active conversion legs inserted or activated in place. */
  readonly committedConversionLegs: number;
  /**
   * BR-005-20c (#143 D10): liquidations this commit wrote at least one row of —
   * a source `Resgate` sold at its liquidation value, or a target credit
   * subscribed at its unit cost.
   */
  readonly resolvedLiquidations: number;
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
  /**
   * BR-005-20b (#129 D1) — every leg of each conversion group already stored
   * on a position that carries a corporate-event row, keyed by group id. A
   * fraction on a conversion target reaches its origin through the group's
   * outgoing leg, which sits on a different position; the legs are read once
   * here so the settling rounds never query again.
   */
  readonly conversionGroups: ReadonlyMap<string, readonly Transaction[]>;
  /**
   * BR-005-20b (#143 D10) — stored subscriptions a liquidation acquired on a
   * position that carries a corporate-event row, by transaction id, each with
   * its `liquidationGroupKey`. A fraction imported after its liquidation took
   * effect reaches its origin through these.
   */
  readonly liquidationAcquisitions: ReadonlyMap<string, string>;
}

/** A resolved corporate-event row in a settling round, and what it writes. */
interface CorporateWrite {
  readonly planned: PlannedCorporateRow;
  readonly status: 'resolved' | 'consumed';
  readonly transaction: Transaction;
}

interface ConversionWrite {
  readonly transaction: Transaction;
  readonly row: ImportRow | null;
  readonly mode: 'insert' | 'in_place' | 'companion';
  readonly origin: ImportBatchId | null;
  /**
   * #143 — an `in_place` leg whose stored copy was already an **active sell**
   * of the same quantity (a priced `Resgate` an earlier import applied under
   * BR-005-18 v3). Its quantity already left the position and every wallet
   * allocation, and its cash already left net contributions; retyping it
   * changes only where its cost goes. It is therefore not reported in
   * `committed`, whose wallet side would otherwise reduce the allocations a
   * second time (SPEC-010 BR-010-17).
   */
  readonly retypedActive?: boolean | undefined;
  /**
   * #143 D10 — the `liquidationGroupKey` of a liquidation's row (a source's
   * `sell`, a target's `subscription`); absent on a conversion leg. A
   * liquidation writes through the same path as a conversion — in place or
   * inserted, replacing the row's ordinary candidate, declined as one group —
   * but its rows are ordinary trades, so they carry no `conversionGroupId`.
   */
  readonly liquidation?: string | undefined;
}

/** The group a write is declined with: its conversion group, or its liquidation. */
function declineKeyOf(write: ConversionWrite): string | null {
  return write.transaction.conversionGroupId ?? write.liquidation ?? null;
}

interface ConversionPlan {
  readonly writes: readonly ConversionWrite[];
}

/** #128 D2: the preview settlement gives nothing up — exclusions belong to the settling rounds. */
const NO_EXCLUSIONS: ReadonlySet<string> = new Set<string>();

interface Group {
  readonly key: PositionKey;
  readonly candidates: Candidate[];
  readonly carried: CarriedCredit[];
  readonly reclassified: Reclassification[];
  readonly conversions: ConversionWrite[];
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

/** One settling round: what it made of every position, and what it settled. */
interface Settlement {
  readonly groups: readonly Group[];
  /**
   * SPEC-005 BR-005-20a — the carry legs this round gave a cost to, by import
   * row id. A credit not in here will not be `active` in the ledger when the
   * commit ends, which is what `debitsHeldBack` (#135) asks of it.
   */
  readonly resolvedCarryIds: ReadonlySet<string>;
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

type StoredLedger = ((key: PositionKey) => readonly Transaction[]) & {
  prime(key: PositionKey, transactions: readonly Transaction[]): void;
};

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
      resolvedAssetConversions: 0,
      committedConversionLegs: 0,
      resolvedLiquidations: 0,
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
  const context = { batchId: batch.id, userId, now, today };
  const plannedReclassifications = planReclassifications(rows, stored, carryLegs, today);
  /**
   * SPEC-005 BR-005-20c (#143 D10) — liquidations are planned **first**: they
   * depend on no conversion and no corporate event of this commit, while a
   * later conversion (`rvbi11-to-psec11`) measures a position the liquidation
   * filled, and a fraction on it takes the liquidation as its origin.
   */
  const liquidationWrites = input.assetConversionsEnabled
    ? await planLiquidations(
        deps,
        rows,
        newCandidates,
        carryLegs,
        plannedReclassifications,
        stored,
        context,
        input.assetConversionWindowDays,
      )
    : [];
  // A row the liquidation writes is not also activated as the older map's
  // `sell` (#110): the liquidation is what that row now means.
  const liquidated = new Set<string>(liquidationWrites.map((write) => write.transaction.id));
  const reclassifications = plannedReclassifications.filter((r) => !liquidated.has(r.updated.id));
  const corporate = await planCorporateEvents(
    deps,
    rows,
    stored,
    context,
    input.corporateEventWindows,
  );

  /**
   * SPEC-005 BR-005-20c (#128 D2) — **conversions are measured against a
   * position whose corporate events have settled.**
   *
   * A conversion's outgoing quantity is `replayed position immediately before
   * the statement date − the statement quantity`. An unresolved `Fração em
   * Ativos` is stored `unclassified` and excluded from replay (BR-007-16), so
   * planning conversions before corporate settlement replayed AXIA7 as 68,34
   * on 2026-08-11 rather than 68, and moved 4,34 units — and 4,34/68,34 of the
   * cost — into AXIA13 instead of 4. A quantity error and a silent cost-basis
   * error, both indistinguishable from a correct figure on the report.
   *
   * **The dependency is mutual**, so the order cannot simply be swapped: the
   * KLBN3/KLBN4 fractions need their KLBN11 conversion legs in the replay
   * before their origin's `quantityAfter` can be computed, while AXIA7's
   * conversion needs its fraction settled first.
   *
   * **Two bounded passes, never a fixpoint loop** (#125 — a settlement loop
   * that did not terminate is why that rule exists):
   *
   * 1. plan conversions with no corporate settlement — enough for KLBN11,
   *    whose legs depend on no corporate event;
   * 2. settle corporate events once against those legs;
   * 3. plan conversions again with the settled events in the replay.
   *
   * The final `settle` rounds below then resolve corporate events again with
   * the pass-2 legs in history, keeping their existing monotonic-decline
   * semantics. Passes 1 and 2 read the same inputs and write nothing, so the
   * plan is deterministic: the same file always produces the same groups.
   */
  const planConversions = async (settledCorporate: readonly Transaction[]) =>
    input.assetConversionsEnabled
      ? {
          writes: [
            ...liquidationWrites,
            ...(
              await planAssetConversions(
                deps,
                rows,
                newCandidates,
                carryLegs,
                stored,
                context,
                input.assetConversionWindowDays,
                settledCorporate,
                liquidationWrites,
              )
            ).writes,
          ],
        }
      : { writes: [] };
  const firstPass = await planConversions([]);
  const settledCorporate =
    input.assetConversionsEnabled && corporate.rows.length > 0
      ? settledCorporateTransactions(
          newCandidates,
          carryLegs,
          reclassifications,
          stored,
          firstPass.writes,
          corporate,
        )
      : [];
  // Nothing settled — a commit with no corporate rows, or one whose rows all
  // refused. Pass 2 would read exactly the inputs pass 1 did.
  const conversionPlan =
    settledCorporate.length === 0 ? firstPass : await planConversions(settledCorporate);

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
  const conversionDeclined = new Set<string>();
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
      conversionPlan.writes.filter((write) => {
        const key = declineKeyOf(write);
        return key === null || !conversionDeclined.has(key);
      }),
      corporate,
      corporateDeclined,
    );
  /**
   * SPEC-005 BR-005-20a (#135) — a same-position transfer pair is all or
   * nothing, so a debit whose counterpart credit will not be `active` when
   * this commit ends is never written. Excluding it makes the row `invalid`:
   * nothing is written, no occurrence is taken, and importing the file again
   * applies it once the credit can take its cost (BR-005-17).
   *
   * Asked of the **relation**, not of `pairTransfers`' one-to-one matches: the
   * shapes where no pair forms are precisely the ones where two debits could
   * empty a position between them (review finding 1). A credit already active
   * in the ledger settles its debit too — an earlier import carried it, and
   * this file is simply meeting both rows again.
   */
  const legOf = (row: ImportRow, id: string): TransferLeg[] =>
    row.record.kind === 'transaction'
      ? [
          {
            id,
            assetId: row.assetId,
            institutionId: row.institutionId,
            tradeDate: row.record.tradeDate,
            quantity: row.record.quantity,
          },
        ]
      : [];
  const carriedRowIdOf = new Set(carryLegs.map((leg) => leg.id));
  const holdBackPairedDebits = (settlement: Settlement): boolean => {
    const unsettled = rows
      .filter((row) => {
        if (!isCarryCandidate(row)) return false;
        if (carriedRowIdOf.has(row.id)) return !settlement.resolvedCarryIds.has(row.id);
        // Not a carry leg of this commit: only a copy the ledger already holds
        // active keeps the position whole.
        return storedCopyOf(stored, row)?.status !== 'active';
      })
      .flatMap((row) => legOf(row, row.id));
    const debits = newCandidates
      .filter((c) => c.transaction.type === 'transfer_out' && !excluded.has(c.row.id))
      .flatMap((c) => legOf(c.row, c.row.id));

    let added = false;
    for (const rowId of debitsHeldBack(debits, unsettled)) {
      excluded.add(rowId as ImportRowId);
      added = true;
    }
    return added;
  };

  let settlement = settleRound();
  for (;;) {
    // Before the ladder below, not after (review finding 2). A round that
    // gives up a *sale* because the position was emptied by a debit this rule
    // was going to hold back never reconsiders it — exclusions only grow — and
    // the batch then shows that sale as `applicable` on every re-import.
    if (holdBackPairedDebits(settlement)) {
      settlement = settleRound();
      continue;
    }
    const failed = settlement.groups.filter((group) => group.state === null);
    if (failed.length === 0) break;
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
      // #113 follow-up: a consumed Leilão is a corporate write but does not
      // enter replay. If the pre-existing ledger already fails on its own,
      // there is therefore no resolved transaction for `corporateCulprit` to
      // identify. Decline every remaining corporate write in the group so the
      // next round leaves the rows unclassified instead of spinning forever.
      if (group.corporate.length > 0) {
        for (const write of group.corporate) corporateDeclined.add(write.planned.event.id);
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
      // BR-005-20c: one failed position declines the complete conversion
      // group. The next round removes every leg, including those whose own
      // position replayed, and the evidence rows fall back to unclassified.
      // #143 D10: a liquidation is declined the same way, whole — its rows
      // fall back to what they were (a new row to its ordinary candidate).
      if (group.conversions.length > 0) {
        for (const write of group.conversions) {
          const key = declineKeyOf(write);
          if (key !== null) conversionDeclined.add(key);
        }
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
  const conversionRowIds = new Set<ImportRowId>();
  const insertedConversionRowIds = new Set<ImportRowId>();
  const conversionInPlace: ConversionWrite[] = [];
  const committedConversions: Transaction[] = [];

  for (const group of settlement.groups) {
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
    for (const write of group.conversions) {
      committedConversions.push(write.transaction);
      if (write.row !== null) conversionRowIds.add(write.row.id);
      if (write.mode === 'in_place') {
        conversionInPlace.push(write);
        continue;
      }
      toInsert.push(write.transaction);
      if (write.row !== null) {
        insertedConversionRowIds.add(write.row.id);
        rowToTransaction.set(write.row.id, write.transaction.id);
      }
    }
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
      group.conversions.length > 0 ||
      group.corporate.some((c) => c.status === 'resolved');
    if (changesPosition) positionUpserts.push({ ...group.key, state: group.state });
  }

  // `unclassified` rows are excluded from replay by `status`
  // (`selectForReplay`, SPEC-007), so they can never make a position
  // unreplayable and never need the group check above.
  for (const row of unclassifiedRows) {
    if (
      carriedRowIds.has(row.id) ||
      corporateRowClassification.has(row.id) ||
      conversionRowIds.has(row.id)
    ) {
      continue;
    }
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
  // SPEC-005 BR-005-20c: row-backed conversion legs activate the existing
  // imported transaction in place. All updates share this commit's tenant
  // transaction, so no partial group can become durable.
  for (const write of conversionInPlace) {
    await deps.transactions.update(write.transaction);
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
  for (const rowId of insertedConversionRowIds) {
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
  await markConversionOrigins(deps, conversionInPlace);

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
    resolvedAssetConversions: new Set(
      committedConversions.flatMap((transaction) =>
        transaction.conversionGroupId === null ? [] : [transaction.conversionGroupId],
      ),
    ).size,
    committedConversionLegs: committedConversions.filter(
      (transaction) => transaction.conversionGroupId !== null,
    ).length,
    resolvedLiquidations: new Set(
      liquidationWrites
        .filter((write) => committedConversions.includes(write.transaction))
        .map((write) => write.liquidation),
    ).size,
    consumedAuctions: supersededInserts.length + superseded.filter(isCorporate).length,
    // Superseded rows are left out: they enter no calculation (BR-006-03).
    committed: [
      ...toInsert,
      ...conversionInPlace
        .filter((write) => write.retypedActive !== true)
        .map((write) => write.transaction),
      ...promoted,
      ...recarried,
      ...activated,
    ],
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
      corporateEventMovementOf(row.record.b3Type) !== null ||
      conversionEvidenceMovementOf(row.record.b3Type, {
        assetClass: row.record.assetClass,
        priceStated: row.record.priceStated,
      }) !== null;
    if (!touches) continue;
    const key = positionKeyString(row);
    if (ledgers.has(key)) continue;
    ledgers.set(key, await deps.transactions.listForPosition(row.assetId, row.institutionId));
  }
  const read = ((key: PositionKey) => ledgers.get(positionKeyString(key)) ?? []) as StoredLedger;
  read.prime = (key, transactions) => ledgers.set(positionKeyString(key), transactions);
  return read;
}

/** The stored transaction a staged `duplicate` row stands for — same key, same occurrence. */
function storedCopyOf(stored: StoredLedger, row: ImportRow): Transaction | undefined {
  return stored(row).find(
    (t) => t.naturalKey === row.naturalKey && t.occurrence === row.occurrence,
  );
}

/**
 * #143 — a priced `Resgate` an earlier map stored `unclassified` under the
 * placeholder key (`…|rendimento|…|resgate`) and a later import then activated
 * in place as a `sell` keeps that `unmapped` key, while a re-import stages the
 * same row under its `mapped` key (`…|sell|…`). `storedCopyOf` misses it, so
 * the BPFF11/HGFF11 `Resgate`s were never found on the owner's ledger — the
 * evidence a liquidation (#143 D10) now reprices in place. Same rebuild
 * `planReclassifications` uses: `keyFormsFor`, same occurrence.
 */
function storedCopyAcrossKeyForms(stored: StoredLedger, row: ImportRow): Transaction | undefined {
  const exact = storedCopyOf(stored, row);
  if (exact !== undefined || row.record.kind !== 'transaction' || row.ledgerType === null) {
    return exact;
  }
  const { unmapped } = keyFormsFor(
    {
      assetId: row.assetId,
      institutionId: row.institutionId,
      tradeDate: row.record.tradeDate,
      quantity: row.record.quantity,
      unitPrice: row.record.unitPrice,
    },
    row.ledgerType,
    row.record.b3Type,
  );
  return stored(row).find((t) => t.naturalKey === unmapped && t.occurrence === row.occurrence);
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
            priceStated: row.record.priceStated,
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

/**
 * BR-005-20a — the carried credits as planning sees them: each leg at the cost
 * its source's history gives it, before any settling round.
 */
function carriedTransactionsOf(
  candidates: readonly Candidate[],
  carryLegs: readonly PlannedCarry[],
  stored: StoredLedger,
): readonly Transaction[] {
  const candidateTransactions = candidates.map((candidate) => candidate.transaction);
  const carriedCosts = resolveCarriedCosts(carryLegs, (assetId, institutionId) => [
    ...stored({ assetId, institutionId }).filter(
      (transaction) => !carryLegs.some((leg) => leg.credit.id === transaction.id),
    ),
    ...candidateTransactions.filter(
      (transaction) =>
        transaction.assetId === assetId && transaction.institutionId === institutionId,
    ),
  ]);
  return carryLegs.flatMap((leg) => {
    const cost = carriedCosts.get(leg.id);
    return cost === undefined ? [] : [withCarriedCost(leg.credit, cost)];
  });
}

/**
 * The B3 type an **unmapped** key names (`…|resgate`, `…|atualizacao`), or
 * `null` for a mapped key, whose last part is the unit price.
 */
function storedB3TypeOf(naturalKey: string): string | null {
  const parts = naturalKey.split('|');
  return parts.length === 7 ? (parts[6] as string) : null;
}

/** A row B3 states as a **priced** `Resgate` — v3's sell, and a liquidation's source evidence. */
function isPricedRedemptionRow(row: ImportRow): boolean {
  return (
    row.record.kind === 'transaction' &&
    row.record.priceStated &&
    normalizeMovementType(row.record.b3Type) === 'resgate'
  );
}

/** A row B3 states as a price-less `Atualização` — a liquidation's target credit. */
function isAtualizacaoRow(row: ImportRow): boolean {
  return (
    row.record.kind === 'transaction' &&
    conversionEvidenceMovementOf(row.record.b3Type, {
      assetClass: row.record.assetClass,
      priceStated: row.record.priceStated,
    }) === 'atualizacao'
  );
}

const imported = (t: Transaction) => !t.isUserModified && !t.isManual && t.importBatchId !== null;

/** #143 D10 — see `CorporatePlan.liquidationAcquisitions`. */
function isStoredLiquidationAcquisition(
  t: Transaction,
  definition: AssetLiquidationDefinition,
): boolean {
  return (
    t.status === 'active' &&
    t.type === 'subscription' &&
    t.unitPrice.equals(definition.target.unitCost) &&
    t.fees.isZero() &&
    storedB3TypeOf(t.naturalKey) === 'atualizacao'
  );
}

/**
 * A source row is already the liquidation's sale when it is an active `sell`
 * at the liquidation value with no fees — whoever wrote it.
 */
function isLiquidationSale(t: Transaction, liquidationValue: Money): boolean {
  return (
    t.status === 'active' &&
    t.type === 'sell' &&
    t.unitPrice.equals(liquidationValue) &&
    t.fees.isZero()
  );
}

interface LiquidationRef {
  readonly evidence: LiquidationEvidence;
  readonly transaction: Transaction;
  readonly row: ImportRow | null;
  readonly mode: 'insert' | 'in_place';
  readonly origin: ImportBatchId | null;
  readonly retypedActive: boolean;
}

/**
 * SPEC-005 BR-005-20c (#143 D10) — the liquidations this commit completes, as
 * writes through the conversion path (`ConversionWrite.liquidation`).
 *
 * Per definition and institution, every row of the group is gathered from the
 * batch and the ledger, given its state (`LiquidationEvidenceState`), and
 * handed to `resolveLiquidation`, which decides all or nothing:
 *
 * - a source's priced `Resgate`: this batch's `new` sell candidate (replaced,
 *   same id), or its stored copy under either key form — an `unclassified`
 *   one, or an active `sell` an earlier import applied at B3's cash price,
 *   which is **repriced in place** to the liquidation value (key kept, not a
 *   user edit, BR-005-20). A stored sell under the mapped key is recognisable
 *   only through its row: that key does not say `Resgate`, so it could be an
 *   ordinary sale;
 * - a target credit: this batch's `unclassified` `Atualização`, or its stored
 *   copy on the receipt code, **moved in place** to the ledger code as a
 *   `subscription` at the unit cost — the same retyping a conversion leg gets.
 *   One already moved is found on the ledger code, as `applied`.
 *
 * The sources' own `Atualização` restatements are no evidence of anything
 * here and stay `unclassified`.
 */
async function planLiquidations(
  deps: IngestionDependencies,
  rows: readonly ImportRow[],
  candidates: readonly Candidate[],
  carryLegs: readonly PlannedCarry[],
  reclassifications: readonly Reclassification[],
  stored: StoredLedger,
  context: { batchId: ImportBatchId; userId: UserId; now: Date; today: BusinessDate },
  windowDays: number,
): Promise<readonly ConversionWrite[]> {
  const writes: ConversionWrite[] = [];
  const candidateByRow = new Map(candidates.map((c) => [c.row.id as string, c.transaction]));
  const carried = carriedTransactionsOf(candidates, carryLegs, stored);
  const activations = reclassifications.filter((r) => r.kind === 'activate').map((r) => r.updated);

  for (const definition of ASSET_LIQUIDATION_DEFINITIONS) {
    const sourceCodes = definition.sources.map((source) => source.assetCode);
    const evidenceCode = definition.target.evidenceAssetCode ?? definition.target.assetCode;
    const triggering = rows.filter(
      (row) =>
        row.record.kind === 'transaction' &&
        ((sourceCodes.includes(row.record.assetCode) && isPricedRedemptionRow(row)) ||
          (row.record.assetCode === evidenceCode && isAtualizacaoRow(row))),
    );
    for (const institutionId of new Set(triggering.map((row) => row.institutionId))) {
      const atInstitution = triggering.filter((row) => row.institutionId === institutionId);
      const [first] = atInstitution;
      const assetClass = first?.record.kind === 'transaction' ? first.record.assetClass : 'stock';
      const codeToAsset = new Map<string, ImportRow['assetId']>();
      const ledgerOf = new Map<string, readonly Transaction[]>();
      for (const code of [...sourceCodes, evidenceCode, definition.target.assetCode]) {
        if (codeToAsset.has(code)) continue;
        const staged = rows.find(
          (row) =>
            row.institutionId === institutionId &&
            row.record.kind === 'transaction' &&
            row.record.assetCode === code,
        );
        const assetId =
          staged?.assetId ??
          (await deps.assets.resolve({
            code,
            name: code,
            // A guess only ever fills a new catalogue entry (#108): the class
            // of the rows that named this liquidation.
            assetClass,
            classStated: false,
            nameStated: false,
          }));
        codeToAsset.set(code, assetId);
        const ledger = await deps.transactions.listForPosition(assetId, institutionId);
        ledgerOf.set(code, ledger);
        // The target may be touched by no row of this batch, and settlement
        // replays it: its stored history must be there (as for a conversion).
        stored.prime({ assetId, institutionId }, ledger);
      }
      const historyOf = (code: string, date: BusinessDate): readonly Transaction[] => {
        const assetId = codeToAsset.get(code);
        const onPosition = (t: Transaction) =>
          t.assetId === assetId && t.institutionId === institutionId;
        return [
          ...(ledgerOf.get(code) ?? []).filter(
            (t) => !carryLegs.some((leg) => leg.credit.id === t.id),
          ),
          ...candidates.map((c) => c.transaction).filter(onPosition),
          ...carried.filter(onPosition),
          ...activations.filter(onPosition),
        ].filter((t) => isBeforeConversion(t, date));
      };

      const refs: LiquidationRef[] = [];
      const represented = new Set<string>();
      const add = (
        ref: Omit<LiquidationRef, 'evidence'>,
        evidence: Omit<LiquidationEvidence, 'id'>,
      ) => {
        represented.add(ref.transaction.id);
        refs.push({ ...ref, evidence: { ...evidence, id: ref.transaction.id } });
      };

      for (const source of definition.sources) {
        const heldBefore = (date: BusinessDate) => {
          const replayed = replayPosition(historyOf(source.assetCode, date));
          return replayed.ok ? replayed.value.quantity : null;
        };
        const stateOf = (copy: Transaction) =>
          isLiquidationSale(copy, source.liquidationValue)
            ? ('applied' as const)
            : imported(copy) &&
                (copy.status === 'unclassified' ||
                  (copy.status === 'active' && copy.type === 'sell'))
              ? ('open' as const)
              : ('locked' as const);
        for (const row of atInstitution) {
          if (row.record.kind !== 'transaction' || row.record.assetCode !== source.assetCode) {
            continue;
          }
          // A priced `Resgate` always stages as v3's `sell` (BR-005-18): this
          // batch's `new` candidate, or a `duplicate` of a stored copy. An
          // `invalid` row has neither and is no evidence.
          let transaction: Transaction | undefined;
          let mode: LiquidationRef['mode'] = 'insert';
          let origin: ImportBatchId | null = null;
          let state: LiquidationEvidence['state'] = 'open';
          if (row.classification === 'new') {
            transaction = candidateByRow.get(row.id);
          } else if (row.classification === 'duplicate') {
            transaction = storedCopyAcrossKeyForms(stored, row);
            if (transaction !== undefined) {
              mode = 'in_place';
              origin = transaction.importBatchId;
              state = stateOf(transaction);
            }
          }
          if (transaction === undefined) continue;
          add(
            {
              transaction,
              row,
              mode,
              origin,
              retypedActive:
                mode === 'in_place' &&
                transaction.status === 'active' &&
                transaction.type === 'sell',
            },
            {
              role: 'source_redemption',
              assetCode: source.assetCode,
              tradeDate: row.record.tradeDate,
              quantity: row.record.quantity,
              state,
              heldBefore: heldBefore(row.record.tradeDate),
            },
          );
        }
        // Stored without its row in this batch: recognisable only under the
        // unmapped `…|resgate` key, or as the liquidation's sale already.
        for (const t of ledgerOf.get(source.assetCode) ?? []) {
          if (represented.has(t.id)) continue;
          const named = storedB3TypeOf(t.naturalKey) === 'resgate';
          if (!named && !isLiquidationSale(t, source.liquidationValue)) continue;
          if (named && t.status === 'superseded') continue;
          add(
            {
              transaction: t,
              row: null,
              mode: 'in_place',
              origin: t.importBatchId,
              retypedActive: t.status === 'active' && t.type === 'sell',
            },
            {
              role: 'source_redemption',
              assetCode: source.assetCode,
              tradeDate: t.tradeDate,
              quantity: t.quantity,
              state: stateOf(t),
              heldBefore: heldBefore(t.tradeDate),
            },
          );
        }
      }

      // Target credits: on the receipt code until the liquidation moves them.
      const receiptBalanceBefore = (date: BusinessDate) => {
        const replayed = replayPosition(historyOf(evidenceCode, date));
        return replayed.ok ? replayed.value.quantity : null;
      };
      const addedBy = (statement: Quantity, date: BusinessDate) => {
        const before = receiptBalanceBefore(date);
        return before === null ? Quantity.zero() : statement.minus(before);
      };
      const targetLedger = ledgerOf.get(definition.target.assetCode) ?? [];
      const creditStateOf = (copy: Transaction) =>
        isStoredLiquidationAcquisition(copy, definition)
          ? ('applied' as const)
          : imported(copy) && copy.status === 'unclassified'
            ? ('open' as const)
            : ('locked' as const);
      for (const row of atInstitution) {
        if (row.record.kind !== 'transaction' || row.record.assetCode !== evidenceCode) continue;
        let transaction: Transaction | null | undefined;
        let mode: LiquidationRef['mode'] = 'insert';
        let origin: ImportBatchId | null = null;
        let state: LiquidationEvidence['state'] = 'open';
        if (row.classification === 'unclassified') {
          transaction = buildCandidate(
            row,
            context.batchId,
            context.userId,
            'unclassified',
            context.now,
            context.today,
          );
        } else if (row.classification === 'duplicate') {
          // On the receipt code while unapplied; on the ledger code once the
          // liquidation moved it — same key, same occurrence.
          transaction =
            storedCopyOf(stored, row) ??
            targetLedger.find(
              (t) => t.naturalKey === row.naturalKey && t.occurrence === row.occurrence,
            );
          if (transaction !== undefined) {
            mode = 'in_place';
            origin = transaction.importBatchId;
            state = creditStateOf(transaction);
          }
        }
        if (transaction === null || transaction === undefined) continue;
        add(
          { transaction, row, mode, origin, retypedActive: false },
          {
            role: 'target_credit',
            assetCode: evidenceCode,
            tradeDate: row.record.tradeDate,
            quantity:
              state === 'applied'
                ? transaction.quantity
                : addedBy(row.record.quantity, row.record.tradeDate),
            state,
          },
        );
      }
      for (const t of ledgerOf.get(evidenceCode) ?? []) {
        if (
          represented.has(t.id) ||
          t.status !== 'unclassified' ||
          storedB3TypeOf(t.naturalKey) !== 'atualizacao'
        ) {
          continue;
        }
        add(
          {
            transaction: t,
            row: null,
            mode: 'in_place',
            origin: t.importBatchId,
            retypedActive: false,
          },
          {
            role: 'target_credit',
            assetCode: evidenceCode,
            tradeDate: t.tradeDate,
            quantity: addedBy(t.quantity, t.tradeDate),
            state: creditStateOf(t),
          },
        );
      }
      for (const t of targetLedger) {
        if (represented.has(t.id) || !isStoredLiquidationAcquisition(t, definition)) continue;
        add(
          {
            transaction: t,
            row: null,
            mode: 'in_place',
            origin: t.importBatchId,
            retypedActive: false,
          },
          {
            role: 'target_credit',
            assetCode: evidenceCode,
            tradeDate: t.tradeDate,
            quantity: t.quantity,
            state: 'applied',
          },
        );
      }

      const resolution = resolveLiquidation({
        definition,
        evidence: refs.map((ref) => ref.evidence),
        windowDays,
      });
      if (resolution.status !== 'resolved') continue;

      const key = liquidationGroupKey(definition.id, institutionId, resolution.anchorDate);
      const refById = new Map(refs.map((ref) => [ref.evidence.id, ref]));
      const planned: ConversionWrite[] = [];
      for (const plan of resolution.writes) {
        const ref = refById.get(plan.evidenceId) as LiquidationRef;
        const assetId = codeToAsset.get(plan.assetCode) as ImportRow['assetId'];
        const transaction: Transaction = {
          ...ref.transaction,
          assetId,
          institutionId,
          type: plan.type,
          status: 'active',
          tradeDate: plan.tradeDate,
          quantity: plan.quantity,
          unitPrice: plan.unitPrice,
          // #143 D10: the liquidation value is the whole consideration; B3's
          // row states no fee against it.
          fees: Money.zero(),
          totalValue: computeTotalValue(plan.type, plan.quantity, plan.unitPrice, Money.zero()),
          ratio: null,
          conversionGroupId: null,
          costBasis: null,
          isUserModified: false,
          updatedAt: context.now,
        };
        planned.push({
          transaction,
          row: ref.row,
          mode: ref.mode,
          origin: ref.origin,
          retypedActive: ref.retypedActive,
          liquidation: key,
        });
      }
      const valid = planned.every(
        ({ transaction: t }) =>
          validateTransactionDraft(
            {
              type: t.type,
              tradeDate: t.tradeDate,
              quantity: t.quantity,
              unitPrice: t.unitPrice,
              fees: t.fees,
              ratio: t.ratio,
            },
            context.today,
          ).ok,
      );
      if (valid) writes.push(...planned);
    }
  }
  return writes;
}

interface ConversionEvidenceRef {
  readonly evidence: AssetConversionEvidence;
  readonly transaction: Transaction;
  readonly row: ImportRow | null;
  readonly mode: 'insert' | 'in_place';
  readonly origin: ImportBatchId | null;
  /** #143: see `ConversionWrite.retypedActive`. */
  readonly retypedActive?: boolean | undefined;
}

function dateDistance(a: BusinessDate, b: BusinessDate): number {
  const toDay = (value: BusinessDate) => Date.parse(`${value}T00:00:00Z`) / 86_400_000;
  return Math.abs(toDay(a) - toDay(b));
}

function movementFromStoredKey(naturalKey: string) {
  return conversionEvidenceMovementOf(naturalKey.slice(naturalKey.lastIndexOf('|') + 1), {
    assetClass: 'stock',
    priceStated: false,
  });
}

/**
 * #143 — a **priced** `Resgate` is conversion evidence only for a definition
 * that names its asset code in `pricedRedemptionSourceCodes`. The movement map
 * is not changed: everywhere else such a row is BR-005-18 v3's sell.
 */
function isPricedRedemptionOf(row: ImportRow, definition: AssetConversionDefinition): boolean {
  return (
    row.record.kind === 'transaction' &&
    row.record.priceStated &&
    normalizeMovementType(row.record.b3Type) === 'resgate' &&
    (definition.pricedRedemptionSourceCodes ?? []).includes(row.record.assetCode)
  );
}

/** Evidence for any definition — the batch-wide pre-filter. */
function isConversionEvidenceRow(row: ImportRow): boolean {
  return (
    conversionEvidenceForRow(row) !== null ||
    ASSET_CONVERSION_DEFINITIONS.some((definition) => isPricedRedemptionOf(row, definition))
  );
}

function conversionEvidenceForRow(
  row: ImportRow,
  definition?: AssetConversionDefinition,
): AssetConversionEvidence['movement'] | null {
  if (row.record.kind !== 'transaction') return null;
  if (definition !== undefined && isPricedRedemptionOf(row, definition)) return 'resgate';
  const named = conversionEvidenceMovementOf(row.record.b3Type, {
    assetClass: row.record.assetClass,
    priceStated: row.record.priceStated,
  });
  if (named !== null) return named;
  // #121 follow-up: B3 decomposes a fractional KLBN11 unit through price-less
  // Transferência rows on KLBN11/KLBN3/KLBN4. They remain ordinary custody
  // transfers everywhere else; only an explicit conversion definition can
  // consume this evidence as one cross-asset group.
  if (
    normalizeMovementType(row.record.b3Type) === 'transferencia' &&
    (row.ledgerType === 'transfer_in' || row.ledgerType === 'transfer_out')
  ) {
    return row.ledgerType;
  }
  return null;
}

function isBeforeConversion(transaction: Transaction, date: BusinessDate): boolean {
  return (
    BusinessDate.isBefore(transaction.tradeDate, date) ||
    // BR-005-20c is planned after BR-005-20a. A same-day carried credit is
    // therefore established evidence for the conversion, while an ordinary
    // same-day buy remains a later trade and must not inflate its source.
    (transaction.tradeDate === date && transaction.type === 'transfer_in')
  );
}

function chronologicalEvidenceGroups(
  definition: (typeof ASSET_CONVERSION_DEFINITIONS)[number],
  refs: readonly ConversionEvidenceRef[],
  conversionWindowDays: number,
  usedEvidence: ReadonlySet<string>,
  allTargetAnchorDates: readonly BusinessDate[],
): readonly (readonly ConversionEvidenceRef[])[] {
  const targetAnchorCode =
    definition.targets[0]?.evidenceAssetCode ?? definition.targets[0]?.assetCode;
  if (targetAnchorCode === undefined) return [];
  const targetCodes = new Set(
    definition.targets.map((target) => target.evidenceAssetCode ?? target.assetCode),
  );
  const expectedCodes = new Set([...definition.sourceAssetCodes, ...targetCodes]);
  const anchors = refs
    .filter(
      (ref) =>
        ref.evidence.assetCode === targetAnchorCode &&
        ref.evidence.movement !== 'resgate' &&
        !usedEvidence.has(ref.evidence.id),
    )
    .sort((a, b) => BusinessDate.compare(a.evidence.tradeDate, b.evidence.tradeDate));

  return anchors.map((anchor) => {
    const selected: ConversionEvidenceRef[] = [];
    for (const code of expectedCodes) {
      const candidates = refs.filter(
        (ref) =>
          ref.evidence.assetCode === code &&
          // A custody credit into a source position establishes its history;
          // it is not evidence that the source converted. Conversely, a debit
          // from a target is not the target arrival. This distinction keeps a
          // same-day ELET3 custody transfer from stealing AXIA3's target-only
          // conversion while still recognising KLBN's cross-asset legs.
          (!definition.sourceAssetCodes.includes(code) ||
            ref.evidence.movement !== 'transfer_in') &&
          (!targetCodes.has(code) || ref.evidence.movement !== 'transfer_out') &&
          !usedEvidence.has(ref.evidence.id) &&
          dateDistance(anchor.evidence.tradeDate, ref.evidence.tradeDate) <= conversionWindowDays &&
          // A source row belongs to the nearest target statement in a full
          // history file. This keeps March AXIA7/AXIA13 debits with the
          // same-day AXIA15 target instead of stealing them for February's
          // AXIA13 target, while still pairing CPLE's sole later Resgate.
          !allTargetAnchorDates.some(
            (date) =>
              date !== anchor.evidence.tradeDate &&
              dateDistance(date, ref.evidence.tradeDate) <
                dateDistance(anchor.evidence.tradeDate, ref.evidence.tradeDate),
          ),
      );
      const sameDate = candidates.filter(
        (ref) => ref.evidence.tradeDate === anchor.evidence.tradeDate,
      );
      if (sameDate.length > 0) {
        // More than one same-code row on the event date remains ambiguous;
        // pass all of them to the pure resolver so it refuses rather than a
        // file-order choice silently selecting one.
        selected.push(...sameDate);
      } else if (candidates.length === 1) {
        // CPLE's target statement precedes its unique source Resgate. The
        // configured window permits that cross-date pair without guessing.
        selected.push(candidates[0] as ConversionEvidenceRef);
      } else if (candidates.length > 1) {
        // Several non-same-day candidates are genuinely ambiguous. Preserve
        // them so `resolveAssetConversion` returns `ambiguous`.
        selected.push(...candidates);
      }
    }
    return [...new Map(selected.map((ref) => [ref.evidence.id, ref])).values()];
  });
}

/**
 * #128 D2 — the corporate-event rows this commit would settle, resolved once
 * so `planAssetConversions` can measure its statements against a position
 * those events have already moved (BR-005-20b before BR-005-20c).
 *
 * Deliberately `settle` itself rather than a second call to
 * `resolveCorporateEvents`: the history a corporate event is resolved against
 * — stored ledger, this batch's live candidates, carried transfers,
 * activations and the conversion legs planned so far — is assembled in exactly
 * one place, and a preview assembling it differently would resolve differently
 * from the settlement that follows.
 *
 * Nothing is given up here (`NO_EXCLUSIONS`): this pass writes nothing, and
 * the settling rounds below decide what a failed replay costs.
 */
function settledCorporateTransactions(
  newCandidates: readonly Candidate[],
  carryLegs: readonly PlannedCarry[],
  reclassifications: readonly Reclassification[],
  stored: StoredLedger,
  conversionWrites: readonly ConversionWrite[],
  corporate: CorporatePlan,
): readonly Transaction[] {
  return settle(
    newCandidates,
    carryLegs,
    reclassifications,
    stored,
    NO_EXCLUSIONS,
    NO_EXCLUSIONS,
    NO_EXCLUSIONS,
    conversionWrites,
    corporate,
    NO_EXCLUSIONS,
  ).groups.flatMap((group) => group.corporate.map((write) => write.transaction));
}

/**
 * SPEC-005 BR-005-20c: gather current and stored untouched evidence, replay
 * each involved position immediately before its statement, then ask the pure
 * resolver for an all-or-nothing group. Transfer carries are supplied first;
 * the resulting conversion legs are supplied to corporate-event settlement.
 *
 * `settledCorporate` (#128 D2) is what corporate-event settlement makes of
 * this commit's Desdobro, Grupamento, Fração em Ativos and Leilão de Fração
 * rows. Their stored copies are `unclassified` and so excluded from replay
 * (BR-007-16); these resolved forms are what actually moves the position a
 * conversion statement is measured against. Empty on the first pass.
 */
async function planAssetConversions(
  deps: IngestionDependencies,
  rows: readonly ImportRow[],
  candidates: readonly Candidate[],
  carryLegs: readonly PlannedCarry[],
  stored: StoredLedger,
  context: { batchId: ImportBatchId; userId: UserId; now: Date; today: BusinessDate },
  conversionWindowDays: number,
  settledCorporate: readonly Transaction[],
  liquidationWrites: readonly ConversionWrite[],
): Promise<ConversionPlan> {
  const currentEvidence = rows.filter(isConversionEvidenceRow);
  if (currentEvidence.length === 0) return { writes: [] };

  const candidateTransactions = candidates.map((candidate) => candidate.transaction);
  const carriedTransactions = carriedTransactionsOf(candidates, carryLegs, stored);

  const writes: ConversionWrite[] = [];
  const usedEvidence = new Set<string>();
  const institutions = [...new Set(currentEvidence.map((row) => row.institutionId))];

  for (const institutionId of institutions) {
    const rowsAtInstitution = currentEvidence.filter((row) => row.institutionId === institutionId);
    const targetEvidenceCodes = new Set(
      ASSET_CONVERSION_DEFINITIONS.flatMap((definition) =>
        definition.targets.map((target) => target.evidenceAssetCode ?? target.assetCode),
      ),
    );
    const allTargetAnchorDates = rowsAtInstitution.flatMap((row) => {
      if (row.record.kind !== 'transaction' || !targetEvidenceCodes.has(row.record.assetCode)) {
        return [];
      }
      const movement = conversionEvidenceForRow(row);
      return movement === null || movement === 'resgate' ? [] : [row.record.tradeDate];
    });
    for (const definition of ASSET_CONVERSION_DEFINITIONS) {
      const evidenceCodes = new Set([
        ...definition.sourceAssetCodes,
        ...definition.targets.map((target) => target.evidenceAssetCode ?? target.assetCode),
      ]);
      const triggering = rowsAtInstitution.filter(
        (row) => row.record.kind === 'transaction' && evidenceCodes.has(row.record.assetCode),
      );
      if (triggering.length === 0) continue;

      const codeToAsset = new Map<string, Awaited<ReturnType<typeof deps.assets.resolve>>>();
      const allCodes = new Set([
        ...evidenceCodes,
        ...definition.targets.map((target) => target.assetCode),
      ]);
      for (const code of allCodes) {
        const staged = rowsAtInstitution.find(
          (row) => row.record.kind === 'transaction' && row.record.assetCode === code,
        );
        const assetId =
          staged?.assetId ??
          (await deps.assets.resolve({
            code,
            name: code,
            assetClass: 'stock',
            classStated: false,
            nameStated: false,
          }));
        codeToAsset.set(code, assetId);
      }

      const ledgerByCode = new Map<string, readonly Transaction[]>();
      for (const code of evidenceCodes) {
        const assetId = codeToAsset.get(code);
        if (assetId === undefined) continue;
        const ledger = await deps.transactions.listForPosition(assetId, institutionId);
        ledgerByCode.set(code, ledger);
        // Target-only evidence does not otherwise make the source position a
        // touched row of this batch; settlement still needs its ledger to
        // replay the generated conversion_out leg.
        stored.prime({ assetId, institutionId }, ledger);
      }

      const refs: ConversionEvidenceRef[] = [];
      const represented = new Set<string>();
      for (const row of triggering) {
        if (row.record.kind !== 'transaction') continue;
        const movement = conversionEvidenceForRow(row, definition);
        if (movement === null) continue;
        const priced = isPricedRedemptionOf(row, definition);
        let retypedActive = false;
        let transaction: Transaction | undefined;
        let mode: ConversionEvidenceRef['mode'] = 'insert';
        let origin: ImportBatchId | null = null;
        if (row.classification === 'unclassified' || row.classification === 'new') {
          transaction =
            buildCandidate(
              row,
              context.batchId,
              context.userId,
              row.classification === 'new' ? 'active' : 'unclassified',
              context.now,
              context.today,
            ) ?? undefined;
        } else if (row.classification === 'duplicate') {
          const copy = priced ? storedCopyAcrossKeyForms(stored, row) : storedCopyOf(stored, row);
          // #143: a priced Resgate an earlier import applied as v3's `sell` is
          // re-read as this definition's outgoing evidence and retyped in
          // place. Only through the row: a stored sell's mapped key does not
          // say it was a `Resgate`, so the stored-ledger scan below never
          // takes one — it could be an ordinary sale.
          const activeSell = priced && copy?.status === 'active' && copy.type === 'sell';
          if (
            copy !== undefined &&
            (copy.status === 'unclassified' ||
              activeSell ||
              (copy.status === 'active' &&
                (copy.type === 'transfer_in' || copy.type === 'transfer_out'))) &&
            !copy.isUserModified &&
            !copy.isManual &&
            copy.importBatchId !== null
          ) {
            transaction = copy;
            mode = 'in_place';
            origin = copy.importBatchId;
            retypedActive = activeSell;
          }
        }
        if (transaction === undefined) continue;
        represented.add(transaction.id);
        refs.push({
          evidence: {
            id: transaction.id,
            movement,
            assetCode: row.record.assetCode,
            tradeDate: row.record.tradeDate,
            beforeQuantity: Quantity.zero(),
            statementQuantity: row.record.quantity,
            // #143 SPEC-007 BR-007-05b: B3's own price and fees — the cash half
            // of the exchange. Read from the transaction, which for an
            // in-place copy is what the ledger already holds.
            ...(priced ? { unitPrice: transaction.unitPrice, fees: transaction.fees } : {}),
          },
          transaction,
          row,
          mode,
          origin,
          retypedActive,
        });
      }

      // Evidence stored by another import can complete the current group.
      for (const [code, ledger] of ledgerByCode) {
        for (const transaction of ledger) {
          if (
            represented.has(transaction.id) ||
            (transaction.status !== 'unclassified' &&
              !(
                transaction.status === 'active' &&
                (transaction.type === 'transfer_in' || transaction.type === 'transfer_out')
              )) ||
            transaction.isUserModified ||
            transaction.isManual ||
            transaction.importBatchId === null
          ) {
            continue;
          }
          const movement =
            transaction.type === 'transfer_in' || transaction.type === 'transfer_out'
              ? transaction.type
              : movementFromStoredKey(transaction.naturalKey);
          if (movement === null) continue;
          refs.push({
            evidence: {
              id: transaction.id,
              movement,
              assetCode: code,
              tradeDate: transaction.tradeDate,
              beforeQuantity: Quantity.zero(),
              statementQuantity: transaction.quantity,
            },
            transaction,
            row: null,
            mode: 'in_place',
            origin: transaction.importBatchId,
          });
        }
      }
      if (refs.length === 0 || refs.every((ref) => ref.row === null)) continue;
      const historyForCode = (code: string): readonly Transaction[] => {
        const assetId = codeToAsset.get(code);
        if (assetId === undefined) return [];
        const storedRows = ledgerByCode.get(code) ?? [];
        // A carried credit and a liquidated row each stand in for their stored
        // or candidate self (#143 D10: a liquidation reuses both ids).
        const replaced = new Set([
          ...carryLegs.map((leg) => leg.credit.id),
          ...liquidationWrites.map((write) => write.transaction.id),
        ]);
        return [
          ...storedRows.filter((transaction) => !replaced.has(transaction.id)),
          ...candidateTransactions.filter(
            (transaction) =>
              transaction.assetId === assetId &&
              transaction.institutionId === institutionId &&
              !replaced.has(transaction.id),
          ),
          ...carriedTransactions.filter(
            (transaction) =>
              transaction.assetId === assetId && transaction.institutionId === institutionId,
          ),
          // #128 D2 / SPEC-005 BR-005-20b: the settled fraction, auction,
          // split or grupamento. Its `unclassified` stored copy may also be in
          // `storedRows` under the same id — that copy is excluded from replay
          // by status, so the position is never moved twice.
          ...settledCorporate.filter(
            (transaction) =>
              transaction.assetId === assetId && transaction.institutionId === institutionId,
          ),
          // #143 D10: a liquidation's rows — RVBI11's subscriptions are the
          // position `rvbi11-to-psec11` measures.
          ...[...liquidationWrites, ...writes]
            .map((write) => write.transaction)
            .filter(
              (transaction) =>
                transaction.assetId === assetId && transaction.institutionId === institutionId,
            ),
        ];
      };
      /**
       * SPEC-005 BR-005-20c (#143) — a source `Atualização` restating the
       * balance the replay already holds is corroboration, not evidence
       * (`corroboratesSourceBalance`). Set aside **before** grouping: as a
       * same-date candidate it would displace the later evidence that
       * actually removed the units — RVBI11's 159,25 of 2025-10-17, before its
       * rename to PSEC11. It stays `unclassified` — see the definition
       * table's v7 note.
       */
      const evidenceRefs = refs.filter((ref) => {
        if (
          ref.evidence.movement !== 'atualizacao' ||
          !definition.sourceAssetCodes.includes(ref.evidence.assetCode)
        ) {
          return true;
        }
        const before = replayPosition(
          historyForCode(ref.evidence.assetCode).filter((transaction) =>
            isBeforeConversion(transaction, ref.evidence.tradeDate),
          ),
        );
        return !(
          before.ok &&
          corroboratesSourceBalance(
            {
              ...ref.evidence,
              beforeQuantity: before.value.quantity,
              statementQuantity: ref.transaction.quantity,
            },
            [definition],
          )
        );
      });
      const groups = chronologicalEvidenceGroups(
        definition,
        evidenceRefs,
        conversionWindowDays,
        usedEvidence,
        allTargetAnchorDates,
      );
      for (const nearby of groups) {
        if (nearby.length === 0 || nearby.every((ref) => ref.row === null)) continue;
        // #143: two same-day target credits are two anchors of one group, so
        // the same evidence can be grouped twice. A group whose evidence an
        // earlier group of this pass already consumed is that group again.
        if (nearby.some((ref) => usedEvidence.has(ref.evidence.id))) continue;
        const enriched: ConversionEvidenceRef[] = [];
        for (const ref of nearby) {
          const before = replayPosition(
            historyForCode(ref.evidence.assetCode).filter((transaction) =>
              isBeforeConversion(transaction, ref.evidence.tradeDate),
            ),
          );
          if (!before.ok) continue;
          const statementQuantity =
            ref.evidence.movement === 'resgate' || ref.evidence.movement === 'transfer_out'
              ? before.value.quantity.minus(ref.transaction.quantity)
              : ref.evidence.movement === 'transfer_in'
                ? before.value.quantity.plus(ref.transaction.quantity)
                : ref.transaction.quantity;
          enriched.push({
            ...ref,
            evidence: {
              ...ref.evidence,
              beforeQuantity: before.value.quantity,
              statementQuantity,
            },
          });
        }

        const fallbackDate = enriched[0]?.evidence.tradeDate;
        if (fallbackDate === undefined) continue;
        const sourcePositions = definition.sourceAssetCodes.map((assetCode) => {
          const sourceEvidence = enriched.find((ref) => ref.evidence.assetCode === assetCode);
          const asAt = sourceEvidence?.evidence.tradeDate ?? fallbackDate;
          const replayed = replayPosition(
            historyForCode(assetCode).filter((transaction) =>
              isBeforeConversion(transaction, asAt),
            ),
          );
          return {
            assetCode,
            quantity: replayed.ok ? replayed.value.quantity : Quantity.zero(),
            totalCost: replayed.ok ? replayed.value.totalCost : null,
          };
        });
        const resolution = resolveAssetConversion({
          definitions: [definition],
          evidence: enriched.map((ref) => ref.evidence),
          sourcePositions,
          conversionWindowDays,
        });
        if (resolution.status !== 'resolved') continue;

        const groupId = ConversionGroupId.generate();
        const refById = new Map(enriched.map((ref) => [ref.evidence.id, ref]));
        const groupWrites: ConversionWrite[] = [];
        for (const leg of resolution.legs) {
          const ref = leg.evidenceId === null ? undefined : refById.get(leg.evidenceId);
          const assetId = codeToAsset.get(leg.assetCode);
          if (assetId === undefined) continue;
          const base = ref?.transaction;
          const transaction: Transaction = {
            ...(base ?? {
              id: TransactionId.generate(),
              userId: context.userId,
              assetId,
              institutionId,
              status: 'active' as const,
              naturalKey: leg.key,
              occurrence: 1,
              importBatchId: context.batchId,
              isManual: false,
              isUserModified: false,
              createdAt: context.now,
            }),
            assetId,
            institutionId,
            type: leg.type,
            status: 'active',
            tradeDate: leg.tradeDate,
            quantity: leg.quantity,
            // #143 SPEC-007 BR-007-05b: a cash-bearing out leg keeps B3's price
            // and fees and carries the cash as its total; every other leg is 0.
            unitPrice: leg.unitPrice,
            fees: leg.fees,
            totalValue: leg.totalValue,
            ratio: null,
            conversionGroupId: groupId,
            costBasis: leg.costBasis,
            importBatchId: base?.importBatchId ?? context.batchId,
            isUserModified: false,
            updatedAt: context.now,
          };
          groupWrites.push({
            transaction,
            row: ref?.row ?? null,
            mode: ref === undefined ? 'companion' : ref.mode,
            origin: ref?.origin ?? null,
            retypedActive: ref?.retypedActive === true && leg.type === 'conversion_out',
          });
        }
        if (!validateAssetConversionGroup(groupWrites.map((write) => write.transaction)).ok) {
          continue;
        }
        writes.push(...groupWrites);
        for (const ref of enriched) usedEvidence.add(ref.evidence.id);
      }
    }
  }
  return { writes };
}

/**
 * One settling round: resolve transfer carries and corporate events together,
 * then replay every group.
 *
 * BR-005-20a/20b + BR-007-15: these two derived effects can alternate in
 * replay order. A transfer into a position can establish P for a later split;
 * that split changes the average cost a still-later transfer carries. The
 * dependency graph is chronological, so each pass moves the known derived
 * state forward and at most one pass per derived row, plus a stability pass,
 * reaches the fixed point.
 */
function settle(
  newCandidates: readonly Candidate[],
  carryLegs: readonly PlannedCarry[],
  reclassifications: readonly Reclassification[],
  stored: StoredLedger,
  excluded: ReadonlySet<string>,
  vetoed: ReadonlySet<string>,
  declined: ReadonlySet<string>,
  conversionWrites: readonly ConversionWrite[],
  corporate: CorporatePlan,
  corporateDeclined: ReadonlySet<string>,
): Settlement {
  const convertedRowIds = new Set(
    conversionWrites.flatMap((write) => (write.row === null ? [] : [write.row.id])),
  );
  // A mapped transfer row can be one of an explicit cross-asset conversion's
  // row-backed legs. In that round the conversion write replaces the ordinary
  // transfer candidate; if the complete group is declined on replay, the
  // write disappears next round and the original candidate returns.
  const live = newCandidates.filter(
    (candidate) => !excluded.has(candidate.row.id) && !convertedRowIds.has(candidate.row.id),
  );
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
  const activations = liveReclassified
    .filter((reclassification) => reclassification.kind === 'activate')
    .map((reclassification) => reclassification.updated);
  /**
   * BR-005-20b (#129 D1) — a conversion group's legs, whether this commit is
   * planning them or an earlier import stored them. Both sources are needed:
   * the KLBN11 decomposition and the fractions it leaves arrive in the same
   * file, so on a first import the outgoing leg exists only as a plan, while
   * on a re-import it is already in the ledger. Deduplicated by id, the
   * planned copy winning — a row-backed leg promoted in place is both.
   */
  /**
   * BR-005-20b (#143 D10) — the liquidation a transaction is an acquisition
   * of: planned by this commit, or recognised in the stored ledger
   * (`CorporatePlan.liquidationAcquisitions`).
   */
  const plannedAcquisitions = new Map<string, string>(
    conversionWrites.flatMap((write) =>
      write.liquidation !== undefined && write.transaction.type === 'subscription'
        ? [[write.transaction.id, write.liquidation] as const]
        : [],
    ),
  );
  const liquidationGroupOf = (transaction: Transaction): string | null =>
    plannedAcquisitions.get(transaction.id) ??
    corporate.liquidationAcquisitions.get(transaction.id) ??
    null;
  const legsOfConversionGroup = (groupId: ConversionGroupId): readonly Transaction[] => {
    const byId = new Map<string, Transaction>(
      (corporate.conversionGroups.get(groupId) ?? []).map((leg) => [leg.id, leg]),
    );
    for (const write of conversionWrites) {
      if (write.transaction.conversionGroupId === groupId)
        byId.set(write.transaction.id, write.transaction);
    }
    return [...byId.values()];
  };

  /**
   * #143 D10 — a stored row a liquidation rewrites in place (a `Resgate` sell
   * repriced to its liquidation value) leaves the history its rewrite enters,
   * so the position never sells twice.
   */
  const liquidatedInPlace = new Set<string>(
    conversionWrites
      .filter((write) => write.liquidation !== undefined && write.mode === 'in_place')
      .map((write) => write.transaction.id),
  );
  const historyFor = (
    key: PositionKey,
    carried: readonly Transaction[],
    corporateTransactions: readonly Transaction[],
  ): readonly Transaction[] => [
    ...stored(key).filter(
      (transaction) => !legCredits.has(transaction.id) && !liquidatedInPlace.has(transaction.id),
    ),
    ...live
      .filter(
        (candidate) =>
          candidate.row.assetId === key.assetId &&
          candidate.row.institutionId === key.institutionId,
      )
      .map((candidate) => candidate.transaction),
    ...activations.filter(
      (transaction) =>
        transaction.assetId === key.assetId && transaction.institutionId === key.institutionId,
    ),
    ...carried.filter(
      (transaction) =>
        transaction.assetId === key.assetId && transaction.institutionId === key.institutionId,
    ),
    ...conversionWrites
      .map((write) => write.transaction)
      .filter(
        (transaction) =>
          transaction.assetId === key.assetId && transaction.institutionId === key.institutionId,
      ),
    ...corporateTransactions.filter(
      (transaction) =>
        transaction.assetId === key.assetId && transaction.institutionId === key.institutionId,
    ),
  ];

  let costs = new Map<string, Money>();
  let outcomes = new Map<string, CorporateEventOutcome>();
  let previousSignature: string | null = null;
  const maximumPasses = legs.length + corporate.rows.length + 2;
  for (let pass = 0; pass < maximumPasses; pass += 1) {
    const priorCorporate = [...outcomes.values()].flatMap((outcome) =>
      outcome.status === 'refused' ? [] : [outcome.transaction],
    );
    costs = new Map(
      resolveCarriedCosts(legs, (assetId, institutionId) =>
        historyFor({ assetId, institutionId }, [], priorCorporate),
      ),
    );
    const carried = legs.flatMap((leg) => {
      const cost = costs.get(leg.id);
      return cost === undefined ? [] : [withCarriedCost(leg.credit, cost)];
    });
    outcomes =
      corporate.rows.length === 0
        ? new Map()
        : new Map(
            resolveCorporateEvents({
              rows: corporate.rows.map((planned) => planned.event),
              history: (key) => historyFor(key, carried, []),
              factors: corporate.factors,
              windows: corporate.windows,
              declined: corporateDeclined,
              conversionLegs: legsOfConversionGroup,
              liquidationGroupOf,
            }),
          );

    const signature = [
      ...[...costs].map(([id, cost]) => `carry:${id}:${asStored(cost)}`),
      ...[...outcomes].map(([id, outcome]) =>
        outcome.status === 'refused'
          ? `corporate:${id}:refused:${outcome.refusal}`
          : `corporate:${id}:${outcome.status}:${outcome.transaction.type}:${outcome.transaction.status}:${outcome.transaction.unitPrice.toString()}:${outcome.transaction.ratio?.toString() ?? ''}`,
      ),
    ]
      .sort()
      .join('|');
    if (signature === previousSignature) break;
    previousSignature = signature;
  }

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
      conversions: ConversionWrite[];
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
      conversions: [],
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
  for (const write of conversionWrites) groupOf(write.transaction).conversions.push(write);
  const replaced = new Set<string>(
    [...groups.values()].flatMap((group) => [
      ...group.carried.map((c) => c.transaction.id),
      ...group.reclassified.map((r) => r.updated.id),
      ...group.conversions
        .filter((write) => write.mode === 'in_place')
        .map((write) => write.transaction.id),
    ]),
  );

  for (const [id, outcome] of outcomes) {
    if (outcome.status === 'refused') continue;
    groupOf(outcome.transaction).corporate.push({
      planned: corporate.byId.get(id) as PlannedCorporateRow,
      status: outcome.status,
      transaction: outcome.transaction,
    });
    replaced.add(outcome.transaction.id);
  }

  return {
    groups: [...groups.values()].map((group) => {
      const ledger = [
        ...stored(group.key).filter((t) => !replaced.has(t.id)),
        ...group.candidates.map((c) => c.transaction),
        ...group.carried.map((c) => c.transaction),
        ...group.reclassified.map((r) => r.updated),
        ...group.conversions.map((write) => write.transaction),
        ...group.corporate.map((c) => c.transaction),
      ];
      const replayed = replayPosition(ledger);
      return {
        ...group,
        ledger,
        waitsForCarry: waiting.has(positionKeyString(group.key)),
        state: replayed.ok ? replayed.value : null,
      };
    }),
    // BR-005-20a (#135): read from this round's `costs`, so a credit that a
    // later round resolves releases its debit rather than refusing it for good.
    resolvedCarryIds: new Set(costs.keys()),
  };
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

  /**
   * #129 D1 — the conversion groups that brought shares onto these positions.
   * Each group's outgoing leg sits on its **source** position, whose ledger
   * `stored` has no reason to hold yet, so it is primed here: `settle`'s
   * `historyFor` reads the source's share-base events through it.
   */
  const conversionGroups = new Map<string, readonly Transaction[]>();
  for (const [, key] of positions) {
    for (const t of stored(key)) {
      const groupId = t.conversionGroupId;
      if (t.type !== 'conversion_in' || t.status !== 'active' || groupId === null) continue;
      if (conversionGroups.has(groupId)) continue;
      const legs = await deps.transactions.listByConversionGroup(groupId);
      conversionGroups.set(groupId, legs);
      for (const leg of legs) {
        if (leg.type !== 'conversion_out') continue;
        const sourceKey = { assetId: leg.assetId, institutionId: leg.institutionId };
        if (stored(sourceKey).length > 0) continue;
        stored.prime(
          sourceKey,
          await deps.transactions.listForPosition(leg.assetId, leg.institutionId),
        );
      }
    }
  }

  /**
   * #143 D10 — a stored liquidation acquisition: an active `subscription` on a
   * liquidation's target, at its stated unit cost, whose key is an
   * `Atualização` credit's. Only the liquidation writes that shape (a B3
   * subscription row's key names no `Atualização`), so no guess is involved.
   */
  const liquidationAcquisitions = new Map<string, string>();
  for (const [id, key] of positions) {
    const ticker = tickers.get(id) as string;
    for (const definition of ASSET_LIQUIDATION_DEFINITIONS) {
      if (definition.target.assetCode !== ticker) continue;
      for (const t of stored(key)) {
        if (isStoredLiquidationAcquisition(t, definition)) {
          liquidationAcquisitions.set(
            t.id,
            liquidationGroupKey(definition.id, t.institutionId, t.tradeDate),
          );
        }
      }
    }
  }

  return {
    rows: planned,
    byId: new Map(planned.map((p) => [p.event.id, p])),
    factors,
    windows,
    conversionGroups,
    liquidationAcquisitions,
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
  // Only a failed group is asked, so its ledger has a first unreplayable row.
  const failure = firstUnreplayable(group.ledger) as ReplayFailure;
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
        // #139 BR-007-04b: a fraction removed between a same-date pair sells at
        // the second event's scale — its quantity changes with its price.
        // Every other activation keeps its own.
        quantity: updated.quantity,
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

/** Keep the original evidence row and batch counters in step with an in-place conversion activation. */
async function markConversionOrigins(
  deps: IngestionDependencies,
  writes: readonly ConversionWrite[],
): Promise<void> {
  const byOrigin = new Map<ImportBatchId, Set<string>>();
  for (const write of writes) {
    if (write.origin === null) continue;
    byOrigin.set(
      write.origin,
      (byOrigin.get(write.origin) ?? new Set<string>()).add(write.transaction.id),
    );
  }
  for (const [origin, transactionIds] of byOrigin) {
    let changed = 0;
    for (const row of await deps.rows.listByBatch(origin)) {
      if (
        row.transactionId === null ||
        !transactionIds.has(row.transactionId) ||
        row.classification !== 'unclassified'
      ) {
        continue;
      }
      await deps.rows.updateClassification(row.id, 'new');
      changed += 1;
    }
    const batch = await deps.batches.findById(origin);
    if (batch === null || batch.rowCounts === null || changed === 0) continue;
    await deps.batches.update({
      ...batch,
      rowCounts: {
        ...batch.rowCounts,
        new: batch.rowCounts.new + changed,
        needsAttention: batch.rowCounts.needsAttention - changed,
      },
    });
  }
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
    conversionGroupId: null,
    costBasis: null,
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
  const snapshots = new Map<string, PositionToReconcile>();
  const coveredClasses = new Set<string>();
  const coveredInstitutions = new Set<string>();
  for (const row of positionRows) {
    if (row.record.kind !== 'position') continue;
    coveredClasses.add(row.record.assetClass);
    coveredInstitutions.add(row.institutionId ?? '');
    const key = `${row.assetId}|${row.institutionId ?? ''}`;
    const seen = snapshots.get(key);
    snapshots.set(key, {
      assetId: row.assetId,
      institutionId: row.institutionId,
      assetCode: seen?.assetCode ?? row.record.assetCode,
      b3Quantity:
        seen === undefined ? row.record.quantity : seen.b3Quantity.plus(row.record.quantity),
      inB3Snapshot: true,
    });
  }

  // SPEC-005 BR-005-22 (amended, #145): the comparison is the *union* of the
  // snapshot and every open ledger position the snapshot is authoritative
  // for — otherwise a holding B3 no longer lists is never compared, and a
  // phantom position reads as reconciled. The file is authoritative for an
  // asset class it carries at least one row of (a tab B3 exported, or a user
  // filtered away, says nothing) and for an institution it names at all (one
  // it never names may be custody the extract does not cover). Classes are the
  // catalog's, which a Posição row's stated class has already overwritten at
  // resolve (#108), so a row and a ledger position of one asset agree.
  if (coveredClasses.size > 0) {
    const ledger = await deps.transactions.export({
      assetClasses: [...coveredClasses],
      statuses: ['active'],
    });
    for (const item of ledger) {
      const { assetId, institutionId } = item.transaction;
      if (item.transaction.status !== 'active') continue;
      if (!coveredClasses.has(item.assetClass)) continue;
      if (!coveredInstitutions.has(institutionId ?? '')) continue;
      const key = `${assetId}|${institutionId ?? ''}`;
      if (snapshots.has(key)) continue;
      snapshots.set(key, {
        assetId,
        institutionId,
        assetCode: item.assetCode,
        b3Quantity: Quantity.zero(),
        inB3Snapshot: false,
      });
    }
  }

  const inputs: ReconciliationInput[] = [];

  for (const {
    assetId,
    institutionId,
    assetCode,
    b3Quantity,
    inB3Snapshot,
  } of snapshots.values()) {
    const existing = await deps.transactions.listForPosition(assetId, institutionId);
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
    // #145: a ledger-only position first traded after the reference date is
    // one B3's snapshot could not have listed yet — not an absence.
    if (
      !inB3Snapshot &&
      (firstComputedTradeDate === null || BusinessDate.isAfter(firstComputedTradeDate, asOf))
    ) {
      continue;
    }

    inputs.push({
      assetId,
      assetCode,
      institutionId,
      computedQuantity,
      b3Quantity,
      firstComputedTradeDate,
      // SPEC-005 BR-005-24 (amended, #113): the ledger's own `unclassified`
      // transactions on the position. A Posição batch never holds unclassified
      // rows, so reading its rows could never give this cause — a Desdobro
      // still unclassified read as missing history.
      hasUnclassifiedRowsAffectingAsset: existing.some((t) => t.status === 'unclassified'),
      inB3Snapshot,
    });
  }

  return reconcilePositions(asOf, inputs);
}

interface PositionToReconcile {
  readonly assetId: ImportRow['assetId'];
  readonly institutionId: ImportRow['institutionId'];
  readonly assetCode: string;
  readonly b3Quantity: Quantity;
  /** #145: false for an open ledger position B3's snapshot does not list — B3 = 0. */
  readonly inB3Snapshot: boolean;
}
