import { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { ImportRowId, InstitutionId, TransactionId } from '@/core/shared/ids';
import { Money, type Quantity } from '@/core/shared/money';
import { type Result, err } from '@/core/shared/result';
import { editTransactions, type EditTransactionsResult } from '@/core/ledger/edit-transaction';
import type { Transaction, TransactionType } from '@/core/ledger/transaction';
import { replayQuantity } from '@/core/positions/replay';
import { SUBSCRIPTION_EXCLUDED_CODES } from '@/core/ingestion/asset-conversion-definitions';
import type { IngestionDependencies } from '@/core/ingestion/dependencies';
import { ingestionError, IngestionUseCaseErrorCode } from '@/core/ingestion/errors';
import { issuerCodeOf } from '@/core/ingestion/issuer-code';
import type { ImportRow } from '@/core/ingestion/ports';
import { summarizeRows } from '@/core/ingestion/stage-batch';
import {
  deriveSubscriptionHandClassification,
  resolveSubscriptions,
  type SubscriptionEvidence,
  type SubscriptionEvidenceState,
} from '@/core/ingestion/subscription-resolution';

/**
 * SPEC-005 BR-005-20d (#157, DL-005-25) — the `offer` pair `commit-batch.ts`'s
 * `planSubscriptions` never writes: a locked, **zero-cost** hand-classified
 * credit whose exercise could otherwise resolve as a subscription. Nothing is
 * written for it at commit (BR-005-20/20b never overwrite a hand
 * classification), so it is derived again here, at read time, exactly as
 * `subscription-close-requests.ts` derives which closes to prefetch — D3 (no
 * new column or table): the pairing is deterministic over the stored ledger.
 *
 * Two actions follow from one offer:
 *
 * - `resolveSubscriptionOffer` — **Resolve as subscription**: re-types the
 *   credit in place at the stored close, superseding the exercise.
 * - `keepSubscriptionClassification` — **Keep my classification**: leaves
 *   the credit exactly as it is, superseding only the exercise.
 */

/** One credit a locked, zero-cost exercise's row could be resolved against. */
export interface SubscriptionOffer {
  readonly exerciseRowId: ImportRowId;
  readonly creditTransactionId: TransactionId;
  /** The main asset's ledger code — never the right ticker. */
  readonly creditAssetCode: string;
  /** What the user classified the credit as today (e.g. `bonificacao`). */
  readonly creditType: TransactionType;
  /** DL-005-22 (D6): the subscription would be dated the credit, not the exercise. */
  readonly tradeDate: BusinessDate;
  readonly quantity: Quantity;
  /**
   * The main asset's stored close on or before `tradeDate`, or `null` where
   * none is stored yet (D1: no invented price — `resolveSubscriptionOffer`
   * refuses `SUBSCRIPTION_CLOSE_MISSING` rather than guess one).
   */
  readonly close: { readonly date: BusinessDate; readonly close: Money } | null;
}

/**
 * SPEC-005 BR-005-20d (#157) — every `unclassified` exercise row among
 * `rows` whose credit is a locked, zero-cost hand classification, rebuilt
 * from the stored ledger the same way `commit-batch.ts`'s `planSubscriptions`
 * would at commit. A row that is not such an exercise, whose pair does not
 * resolve, or that resolves to anything other than `offer` (already applied,
 * `evidence_only`, ambiguous, …) is simply absent from the result — this is a
 * read, never a refusal.
 *
 * `windowDays` is `import.subscription_credit_window_days` (SPEC-002): no
 * default here, as `resolveSubscriptions` itself takes none.
 */
export async function findSubscriptionOffers(
  deps: IngestionDependencies,
  rows: readonly ImportRow[],
  windowDays: number,
): Promise<ReadonlyMap<ImportRowId, SubscriptionOffer>> {
  const offers = new Map<ImportRowId, SubscriptionOffer>();

  const exerciseRows = rows.filter(isUnclassifiedExerciseRow);
  if (exerciseRows.length === 0) return offers;

  const rowIdByExerciseTransactionId = new Map<string, ImportRowId>();
  for (const row of exerciseRows) {
    if (row.transactionId !== null) rowIdByExerciseTransactionId.set(row.transactionId, row.id);
  }

  const groups = new Map<string, { issuerRoot: string; institutionId: InstitutionId | null }>();
  for (const row of exerciseRows) {
    if (row.record.kind !== 'transaction') continue;
    const issuerRoot = issuerCodeOf(row.record.assetCode);
    if (issuerRoot === null) continue;
    groups.set(`${issuerRoot}|${row.institutionId ?? ''}`, {
      issuerRoot,
      institutionId: row.institutionId,
    });
  }

  for (const { issuerRoot, institutionId } of groups.values()) {
    const storedEvidence = await deps.subscriptionEvidence.evidenceForIssuer(
      issuerRoot,
      institutionId,
    );

    const evidence: SubscriptionEvidence[] = [];
    const creditByTransactionId = new Map<string, Transaction>();

    for (const item of storedEvidence) {
      const suffix = storedB3TypeOf(item.transaction.naturalKey);
      // #144 review F7 — once a pair applies, the credit becomes
      // `type: 'subscription'` too, so only the natural key's own B3-type
      // suffix (never rewritten by resolution) still tells the two apart.
      const isExercise =
        item.transaction.type === 'subscription' && suffix === 'direitos de subscricao - exercido';
      const isCredit = !isExercise && suffix === 'atualizacao';
      if (!isExercise && !isCredit) continue;
      // BR-005-20d: "no pair forms when an asset-conversion or liquidation
      // definition names the credit's code" — refused before evidence is
      // even gathered for it, same as `planSubscriptions` (#157 review F1).
      if (isCredit && SUBSCRIPTION_EXCLUDED_CODES.has(item.assetCode)) continue;

      const applied = isExercise
        ? item.transaction.status === 'superseded' && imported(item.transaction)
        : item.transaction.status === 'active' &&
          item.transaction.type === 'subscription' &&
          item.transaction.costIsEstimate &&
          imported(item.transaction);
      const state: SubscriptionEvidenceState = applied
        ? 'applied'
        : imported(item.transaction) && item.transaction.status === 'unclassified'
          ? 'open'
          : 'locked';

      if (isCredit) creditByTransactionId.set(item.transaction.id, item.transaction);

      evidence.push({
        id: item.transaction.id,
        role: isExercise ? 'exercise' : 'credit',
        assetCode: item.assetCode,
        tradeDate: item.transaction.tradeDate,
        quantity: item.transaction.quantity,
        state,
        ...(isCredit
          ? {
              // BR-005-20d (D8): the main position replayed strictly before
              // this credit's date — never inclusive of it, unlike the
              // ordinary `asOf` reading, since the credit's own date is what
              // is in question.
              balanceBefore: await replayBalanceBefore(
                deps,
                item.transaction.assetId,
                institutionId,
                item.transaction.tradeDate,
              ),
              handClassification: deriveSubscriptionHandClassification(item.transaction),
            }
          : {}),
      });
    }

    const resolution = resolveSubscriptions({ evidence, windowDays });
    for (const pair of resolution.pairs) {
      if (pair.status !== 'offer') continue;
      const rowId = rowIdByExerciseTransactionId.get(pair.plan.exerciseId);
      if (rowId === undefined) continue; // Not one of the rows this call was asked about.
      const creditTransaction = creditByTransactionId.get(pair.plan.creditId);
      if (creditTransaction === undefined) continue;

      // DL-005-22: fetched ahead of any write, never invented (D1).
      const close = await deps.closePrices.closeOnOrBefore(
        creditTransaction.assetId,
        pair.plan.tradeDate,
      );

      offers.set(rowId, {
        exerciseRowId: rowId,
        creditTransactionId: creditTransaction.id,
        creditAssetCode: pair.plan.assetCode,
        creditType: creditTransaction.type,
        tradeDate: pair.plan.tradeDate,
        quantity: pair.plan.quantity,
        close,
      });
    }
  }

  return offers;
}

export interface ResolveSubscriptionOfferInput {
  readonly rowId: ImportRowId;
  /** `import.subscription_credit_window_days` (SPEC-002): no default here. */
  readonly windowDays: number;
}

/**
 * SPEC-005 BR-005-20d (#157, DL-005-25) — **Resolve as subscription**: the
 * user confirms a hand-classified, zero-cost credit was actually the paid
 * subscription its exercise never found. Recomputes the offer first — the
 * credit or exercise may have changed since the row was shown — and refuses
 * rather than act on a stale read.
 *
 * One `editTransactions` call carries both legs (#144 D19): BR-006-15's
 * replayability guard then covers the credit's position and the exercise's
 * together, and any carried leg downstream of the credit's new price is
 * re-derived in the same pass (SPEC-007 BR-007-06).
 */
export async function resolveSubscriptionOffer(
  deps: IngestionDependencies,
  input: ResolveSubscriptionOfferInput,
): Promise<Result<EditTransactionsResult, DomainError>> {
  const row = await deps.rows.findById(input.rowId);
  if (row === null || row.transactionId === null) {
    return err(ingestionError(IngestionUseCaseErrorCode.ROW_NOT_FOUND, { rowId: input.rowId }));
  }

  const offers = await findSubscriptionOffers(deps, [row], input.windowDays);
  const offer = offers.get(row.id);
  if (offer === undefined) {
    return err(
      ingestionError(IngestionUseCaseErrorCode.SUBSCRIPTION_OFFER_UNAVAILABLE, { rowId: row.id }),
    );
  }
  // D1 (#144): no stored close, no invented price.
  if (offer.close === null) {
    return err(
      ingestionError(IngestionUseCaseErrorCode.SUBSCRIPTION_CLOSE_MISSING, { rowId: row.id }),
    );
  }

  const result = await editTransactions(deps, [
    {
      id: offer.creditTransactionId,
      input: {
        type: 'subscription',
        unitPrice: offer.close.close,
        fees: Money.zero(),
        // BR-005-17: the B3 row this credit came from has not changed.
        preserveNaturalKey: true,
        // SPEC-007 BR-007-06: B3 states no price for a subscription — the
        // close stands in for it, marked as an estimate.
        costEstimate: { closeDate: offer.close.date },
      },
    },
    {
      id: row.transactionId,
      input: {
        status: 'superseded',
        preserveNaturalKey: true,
      },
    },
  ]);
  if (!result.ok) return result;

  await markExerciseRowIgnored(deps, row);

  return result;
}

export interface KeepSubscriptionClassificationInput {
  readonly rowId: ImportRowId;
  /** `import.subscription_credit_window_days` (SPEC-002): no default here. */
  readonly windowDays: number;
}

/**
 * SPEC-005 BR-005-20d (#157, DL-005-25) — **Keep my classification**: the
 * credit is left exactly as the user classified it; only the exercise
 * supersedes, so it leaves "Needs attention" without a price no one stated.
 */
export async function keepSubscriptionClassification(
  deps: IngestionDependencies,
  input: KeepSubscriptionClassificationInput,
): Promise<Result<EditTransactionsResult, DomainError>> {
  const row = await deps.rows.findById(input.rowId);
  if (row === null || row.transactionId === null) {
    return err(ingestionError(IngestionUseCaseErrorCode.ROW_NOT_FOUND, { rowId: input.rowId }));
  }

  const offers = await findSubscriptionOffers(deps, [row], input.windowDays);
  if (!offers.has(row.id)) {
    return err(
      ingestionError(IngestionUseCaseErrorCode.SUBSCRIPTION_OFFER_UNAVAILABLE, { rowId: row.id }),
    );
  }

  const result = await editTransactions(deps, [
    { id: row.transactionId, input: { status: 'superseded', preserveNaturalKey: true } },
  ]);
  if (!result.ok) return result;

  await markExerciseRowIgnored(deps, row);

  return result;
}

/**
 * SPEC-005 BR-005-20d — the exercise's own row leaves "Needs attention"
 * `ignored`, not `new` — like a resolved pair's exercise (`commit-batch.ts`'s
 * `markSubscriptionOriginsIgnored`), neither action ever moves a position by
 * itself.
 *
 * Recomputed from the batch's own rows (`summarizeRows`, the same read
 * `stage-batch.ts` uses), never a ±1 adjustment (#157 review F2): a double
 * submission of **Resolve as subscription** or **Keep my classification** —
 * two requests racing, or a retried one — would otherwise decrement
 * `needsAttention` twice for a row that left it only once. `read` is the one
 * field a recount cannot recover (rows can outlive the count of what the
 * file originally held none of), so it is carried over unchanged.
 */
async function markExerciseRowIgnored(deps: IngestionDependencies, row: ImportRow): Promise<void> {
  await deps.rows.updateClassification(row.id, 'ignored');
  const batch = await deps.batches.findById(row.batchId);
  if (batch === null || batch.rowCounts === null) return;
  const rows = await deps.rows.listByBatch(batch.id);
  await deps.batches.update({
    ...batch,
    rowCounts: summarizeRows(batch.rowCounts.read, rows),
  });
}

function isUnclassifiedExerciseRow(row: ImportRow): boolean {
  return (
    row.record.kind === 'transaction' &&
    row.classification === 'unclassified' &&
    row.ledgerType === 'subscription'
  );
}

async function replayBalanceBefore(
  deps: IngestionDependencies,
  assetId: Transaction['assetId'],
  institutionId: InstitutionId | null,
  date: BusinessDate,
): Promise<Quantity | null> {
  const history = await deps.transactions.listForPosition(assetId, institutionId);
  const strictlyBefore = history.filter((t) => BusinessDate.isBefore(t.tradeDate, date));
  const replayed = replayQuantity(strictlyBefore);
  return replayed.ok ? replayed.value : null;
}

function storedB3TypeOf(naturalKey: string): string | null {
  const parts = naturalKey.split('|');
  return parts.length === 7 ? (parts[6] ?? null) : null;
}

function imported(transaction: {
  readonly isUserModified: boolean;
  readonly isManual: boolean;
  readonly importBatchId: unknown;
}): boolean {
  return !transaction.isUserModified && !transaction.isManual && transaction.importBatchId !== null;
}
