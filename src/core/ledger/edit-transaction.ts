import { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, InstitutionId, TransactionId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import { LedgerErrorCode, ledgerError } from '@/core/ledger/errors';
import { guardReplayable, without } from '@/core/ledger/guard-replayable';
import { naturalKeyFor } from '@/core/ledger/natural-key';
import {
  computeTotalValue,
  type Transaction,
  type TransactionStatus,
  type TransactionType,
} from '@/core/ledger/transaction';
import { validateTransactionDraft } from '@/core/ledger/validate';
import { recalculatePositionFrom, type RecalculationOutcome } from '@/core/ledger/recalculate-from';

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
  const original = await deps.transactions.findById(id);
  if (original === null) {
    return err(ledgerError(LedgerErrorCode.TRANSACTION_NOT_FOUND, { transactionId: id }));
  }

  const updated = applyEdit(original, input, deps.clock.now());

  const validation = validateTransactionDraft(
    {
      type: updated.type,
      tradeDate: updated.tradeDate,
      quantity: updated.quantity,
      unitPrice: updated.unitPrice,
      fees: updated.fees,
      ratio: updated.ratio,
    },
    deps.clock.today(),
  );
  if (!validation.ok) return validation;

  const movedPosition =
    original.assetId !== updated.assetId || original.institutionId !== updated.institutionId;
  const removed = new Set<string>([original.id]);

  // BR-006-15: the destination ledger must hold together *with* the edited row
  // in it. `without` first, because an edit that only changes the quantity is
  // a replace, not an addition.
  const destinationGuard = await guardReplayable(deps, updated, (existing) => [
    ...without(existing, removed),
    updated,
  ]);
  if (!destinationGuard.ok) return destinationGuard;

  if (movedPosition) {
    // ...and so must the ledger the row left behind. Moving a buy away can
    // strand a sale that depended on it, which is refused rather than left to
    // surface as an unreplayable position later.
    const sourceGuard = await guardReplayable(deps, original, (existing) =>
      without(existing, removed),
    );
    if (!sourceGuard.ok) return sourceGuard;
  }

  await deps.transactions.update(updated);

  /**
   * DL-006-03: recalculation runs forward from the **earlier** of the two
   * dates. Moving a trade from March to June makes March's figures stale too —
   * taking the new date alone would leave every chart between the two dates
   * showing a position that no transaction supports.
   */
  const fromDate = earlier(original.tradeDate, updated.tradeDate);

  const recalculations: RecalculationOutcome[] = [];
  const destination = await recalculatePositionFrom(deps, {
    assetId: updated.assetId,
    institutionId: updated.institutionId,
    fromDate,
  });
  if (!destination.ok) return destination;
  recalculations.push(destination.value);

  if (movedPosition) {
    const source = await recalculatePositionFrom(deps, {
      assetId: original.assetId,
      institutionId: original.institutionId,
      fromDate,
    });
    if (!source.ok) return source;
    recalculations.push(source.value);
  }

  return ok({ transaction: updated, recalculations });
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
    naturalKey: naturalKeyFor({ assetId, institutionId, type, tradeDate, quantity, unitPrice }),
    /**
     * BR-006-16: an edited imported transaction is flagged, and a later
     * re-import must not overwrite the correction. Set unconditionally rather
     * than only for imported rows — a manual row is already protected by
     * having no `import_batch_id` to match on, and a flag that means "a human
     * decided this value" is worth more than one that means "a human decided
     * this value, but only on rows we happened to import".
     */
    isUserModified: true,
    updatedAt: now,
  };
}

function earlier(a: BusinessDate, b: BusinessDate): BusinessDate {
  return BusinessDate.isBefore(a, b) ? a : b;
}
