import { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, InstitutionId, TransactionId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import { LedgerErrorCode, ledgerError } from '@/core/ledger/errors';
import { guardReplayable, type PositionLookupKey, without } from '@/core/ledger/guard-replayable';
import { naturalKeyFor } from '@/core/ledger/natural-key';
import {
  computeTotalValue,
  type Transaction,
  type TransactionStatus,
  type TransactionType,
} from '@/core/ledger/transaction';
import { validateTransactionDraft } from '@/core/ledger/validate';
import {
  recalculatePositionFrom,
  type RecalculationOutcome,
  type RecalculationScope,
} from '@/core/ledger/recalculate-from';

/**
 * SPEC-006 BR-006-12: **any** transaction can be edited, whether manual or
 * imported (DL-006-02).
 *
 * Locking imported rows was considered and rejected: B3 extracts have gaps —
 * missing history before the export range, unmapped movement types, assets
 * outside custody — and a user who cannot correct them keeps wrong numbers and
 * leaves. BR-006-16's `is_user_modified` flag is what protects the correction
 * from being reverted by a later re-import.
 */

/** Only the fields a user may change. Provenance and ids are not among them. */
export interface EditTransactionInput {
  readonly assetId?: AssetId | undefined;
  readonly institutionId?: InstitutionId | null | undefined;
  readonly type?: TransactionType | undefined;
  readonly status?: TransactionStatus | undefined;
  readonly tradeDate?: BusinessDate | undefined;
  readonly quantity?: Quantity | undefined;
  readonly unitPrice?: Money | undefined;
  readonly fees?: Money | undefined;
  readonly ratio?: Quantity | null | undefined;
  /**
   * SPEC-005 BR-005-17 — keep the row's existing natural key instead of
   * recomputing it from the edited fields.
   *
   * BR-006-04 rederives the key when identifying fields change, so that a
   * re-import cannot match an edited row against a trade it is no longer a
   * record of. That is right for a *user editing a trade*, and wrong for the
   * one edit that is not a correction: classifying an `unclassified` import
   * row (BR-005-20).
   *
   * An unclassified row is keyed by `importNaturalKeyFor`, which appends the
   * raw B3 movement type so two different unmapped movements cannot collide.
   * Classifying it supplies a type the source row always implied — the row
   * *in the file* is unchanged. Rederiving the key there produced a key no
   * re-import can ever compute: the next import of the same file recomputes
   * the unclassified key, matches nothing, and inserts the row a second time.
   */
  readonly preserveNaturalKey?: boolean | undefined;
  /**
   * BR-006-16 — `false` for the one edit no human made: import promoting its
   * own unclassified transfer once the carried cost resolves (SPEC-005
   * BR-005-20a, #110). The row gains information from its B3 source rather
   * than a correction, so it is not badged as user-modified. Defaults to
   * flagging.
   */
  readonly flagUserModified?: boolean | undefined;
}

export interface EditTransactionResult {
  readonly transaction: Transaction;
  /**
   * One outcome, or two. Changing the asset or the institution moves the row
   * between positions, and **both** have to be recalculated — the one it left
   * as well as the one it joined. Recalculating only the destination leaves
   * the source position permanently overstated, which is invisible until a
   * rebuild disagrees with it (DM-4).
   */
  readonly recalculations: readonly RecalculationOutcome[];
}

export async function editTransaction(
  deps: LedgerDependencies,
  id: TransactionId,
  input: EditTransactionInput,
): Promise<Result<EditTransactionResult, DomainError>> {
  const result = await editTransactions(deps, [{ id, input }]);
  if (!result.ok) return result;
  const [transaction] = result.value.transactions;
  // One edit in, one transaction out — `editTransactions` returns them in order.
  return ok({
    transaction: transaction as Transaction,
    recalculations: result.value.recalculations,
  });
}

export interface TransactionEdit {
  readonly id: TransactionId;
  readonly input: EditTransactionInput;
}

export interface EditTransactionsResult {
  /** The edited transactions, in the order the edits were given. */
  readonly transactions: readonly Transaction[];
  /** One per position any edit touched — each recalculated once. */
  readonly recalculations: readonly RecalculationOutcome[];
}

/**
 * Several edits applied as one write, and the one implementation of an edit —
 * `editTransaction` is this with a single entry.
 *
 * **Why the guard runs over all of them at once.** Two edits can be legal only
 * together: SPEC-005 BR-005-20a (#110) promotes two unclassified transfers into
 * one position that a later transfer out needs both of. Applied one at a time,
 * the first edit's BR-006-15 replay still sees the second transfer unclassified
 * and refuses a ledger the batch as a whole makes valid. So every position an
 * edit touches is replayed once, with **every** edit in place, and nothing is
 * written unless all of them hold.
 */
export async function editTransactions(
  deps: LedgerDependencies,
  edits: readonly TransactionEdit[],
): Promise<Result<EditTransactionsResult, DomainError>> {
  const now = deps.clock.now();
  const today = deps.clock.today();

  const pairs: { original: Transaction; updated: Transaction }[] = [];
  for (const edit of edits) {
    const original = await deps.transactions.findById(edit.id);
    if (original === null) {
      return err(ledgerError(LedgerErrorCode.TRANSACTION_NOT_FOUND, { transactionId: edit.id }));
    }
    const updated = applyEdit(original, edit.input, now);
    const validation = validateTransactionDraft(
      {
        type: updated.type,
        tradeDate: updated.tradeDate,
        quantity: updated.quantity,
        unitPrice: updated.unitPrice,
        fees: updated.fees,
        ratio: updated.ratio,
      },
      today,
    );
    if (!validation.ok) return validation;
    pairs.push({ original, updated });
  }

  /**
   * Every position touched: each edit's destination, then — when the row moved
   * asset or institution — the one it left, which must be recalculated too.
   * Recalculating only the destination leaves the source permanently
   * overstated, invisible until a rebuild disagrees with it (DM-4).
   *
   * DL-006-03: each recalculates forward from the **earliest** date any edit
   * gave it, the original or the new one. Moving a trade from March to June
   * makes March's figures stale too.
   */
  const scopes = new Map<string, RecalculationScope>();
  const touch = (key: PositionLookupKey, date: BusinessDate) => {
    const id = `${key.assetId}|${key.institutionId ?? ''}`;
    const seen = scopes.get(id);
    scopes.set(id, {
      assetId: key.assetId,
      institutionId: key.institutionId,
      fromDate: seen === undefined ? date : earlier(seen.fromDate, date),
    });
  };
  for (const { original, updated } of pairs) {
    touch(updated, earlier(original.tradeDate, updated.tradeDate));
  }
  for (const { original, updated } of pairs) {
    if (original.assetId !== updated.assetId || original.institutionId !== updated.institutionId) {
      touch(original, earlier(original.tradeDate, updated.tradeDate));
    }
  }

  // BR-006-15: each ledger must hold together with every edit in place.
  // `without` first, because an edit that only changes the quantity is a
  // replace, not an addition; a row moved away is simply absent from the
  // position it left, which is what can strand a sale there.
  const removed = new Set<string>(pairs.map((pair) => pair.original.id));
  for (const scope of scopes.values()) {
    const guard = await guardReplayable(deps, scope, (existing) => [
      ...without(existing, removed),
      ...pairs
        .map((pair) => pair.updated)
        .filter((t) => t.assetId === scope.assetId && t.institutionId === scope.institutionId),
    ]);
    if (!guard.ok) return guard;
  }

  for (const { updated } of pairs) await deps.transactions.update(updated);

  const recalculations: RecalculationOutcome[] = [];
  for (const scope of scopes.values()) {
    const recalculated = await recalculatePositionFrom(deps, scope);
    if (!recalculated.ok) return recalculated;
    recalculations.push(recalculated.value);
  }

  return ok({ transactions: pairs.map((pair) => pair.updated), recalculations });
}

function applyEdit(original: Transaction, input: EditTransactionInput, now: Date): Transaction {
  const assetId = input.assetId ?? original.assetId;
  const institutionId =
    input.institutionId === undefined ? original.institutionId : input.institutionId;
  const type = input.type ?? original.type;
  const tradeDate = input.tradeDate ?? original.tradeDate;
  const quantity = input.quantity ?? original.quantity;
  const unitPrice = input.unitPrice ?? original.unitPrice;
  const fees = input.fees ?? original.fees;
  const ratio = input.ratio === undefined ? original.ratio : input.ratio;

  return {
    ...original,
    assetId,
    institutionId,
    type,
    status: input.status ?? original.status,
    tradeDate,
    quantity,
    unitPrice,
    fees,
    totalValue: computeTotalValue(type, quantity, unitPrice, fees),
    ratio,
    // BR-006-04: the natural key is derived from the identifying fields, so an
    // edit that changes any of them must change the key too. Leaving the old
    // key in place would make a re-import match this row against a trade it is
    // no longer a record of.
    naturalKey:
      input.preserveNaturalKey === true || keepsImportKey(original, input)
        ? original.naturalKey
        : naturalKeyFor({ assetId, institutionId, type, tradeDate, quantity, unitPrice }),
    /**
     * BR-006-16: an edited imported transaction is flagged, and a later
     * re-import must not overwrite the correction. Set unconditionally rather
     * than only for imported rows — a manual row is already protected by
     * having no `import_batch_id` to match on, and a flag that means "a human
     * decided this value" is worth more than one that means "a human decided
     * this value, but only on rows we happened to import".
     */
    isUserModified: input.flagUserModified === false ? original.isUserModified : true,
    updatedAt: now,
  };
}

/**
 * SPEC-005 BR-005-17 (#110) — an imported row whose key is **not** derived
 * from its own fields keeps that key while the B3 row it records is still the
 * same row: same asset, institution, type, date and quantity.
 *
 * Two kinds of imported row are keyed that way. A row staged `unclassified`
 * carries the raw B3 type in its key (`importNaturalKeyFor`), and a carried
 * transfer is keyed at the price B3 stated — none — while it stores the
 * carried cost (BR-005-20a). Rederiving either key on a fees-only or
 * price-only edit produced a key no re-import computes, and the next import of
 * the file wrote the row a second time.
 *
 * A manual row, and an imported row keyed by `naturalKeyFor` itself, are
 * untouched: for them this is never true, and BR-006-04 applies as before.
 */
function keepsImportKey(original: Transaction, input: EditTransactionInput): boolean {
  if (original.importBatchId === null) return false;
  const derived = naturalKeyFor(original);
  if (original.naturalKey === derived) return false;
  return (
    (input.assetId ?? original.assetId) === original.assetId &&
    (input.institutionId === undefined ? original.institutionId : input.institutionId) ===
      original.institutionId &&
    (input.type ?? original.type) === original.type &&
    (input.tradeDate ?? original.tradeDate) === original.tradeDate &&
    (input.quantity ?? original.quantity).equals(original.quantity)
  );
}

function earlier(a: BusinessDate, b: BusinessDate): BusinessDate {
  return BusinessDate.isBefore(a, b) ? a : b;
}
