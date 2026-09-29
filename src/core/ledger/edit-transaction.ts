import { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, InstitutionId, TransactionId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import { LedgerErrorCode, ledgerError } from '@/core/ledger/errors';
import { planCarriedLegUpdates } from '@/core/ledger/carried-legs';
import { guardReplayable, type PositionLookupKey, without } from '@/core/ledger/guard-replayable';
import { naturalKeyFor } from '@/core/ledger/natural-key';
import { UNCLASSIFIED_PLACEHOLDER_TYPE } from '@/core/ingestion/occurrence';
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
  /**
   * SPEC-007 BR-007-06 / SPEC-005 BR-005-20d — sets the cost-estimate marker
   * explicitly: an object marks the row an estimate (with the close date its
   * price was read from, or null when it was read from none), `null` marks it
   * exact. For import's own in-place writes, which recompute the marker with
   * the figure (a re-carried transfer, BR-005-20a).
   *
   * Omitted, the marker is kept — except that a user edit changing the price
   * clears it (see `estimateAfterEdit`).
   */
  readonly costEstimate?: { readonly closeDate: BusinessDate | null } | null | undefined;
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
  /** SPEC-007 BR-007-06 (#144 F6): carried legs downstream, re-derived with the edit. */
  readonly rederived: readonly Transaction[];
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
    rederived: result.value.rederived,
  });
}

export interface TransactionEdit {
  readonly id: TransactionId;
  readonly input: EditTransactionInput;
}

export interface EditTransactionsResult {
  /** The edited transactions, in the order the edits were given. */
  readonly transactions: readonly Transaction[];
  /**
   * One per position any edit touched — each recalculated once — including
   * every position a re-derived carried leg sits in (`carried-legs.ts`).
   */
  readonly recalculations: readonly RecalculationOutcome[];
  /** SPEC-007 BR-007-06 (#144 F6): carried legs downstream, re-derived with the edit. */
  readonly rederived: readonly Transaction[];
}

export interface EditTransactionsOptions {
  /**
   * SPEC-007 BR-007-06 (#144 F6): re-derive the carried transfer credits and
   * import-resolved conversion legs downstream of the edited positions
   * (`carried-legs.ts`). Default on. Import's own in-place writes turn it off:
   * a commit resolves carries itself, over the ledger *and* its batch
   * (SPEC-005 BR-005-20a), and a second derivation over the stored ledger alone
   * could disagree with it mid-commit.
   */
  readonly rederiveCarriedLegs?: boolean;
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
  options: EditTransactionsOptions = {},
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

  const removed = new Set<string>(pairs.map((pair) => pair.original.id));
  const edited = pairs.map((pair) => pair.updated);

  /**
   * SPEC-007 BR-007-06 (#144 F6): the carried legs downstream of every
   * position the edits touched, re-derived over the ledger as the edits leave
   * it — so correcting an estimated price at A clears the marker, and the cost
   * read from the estimate, on what A carried to B. Planned before anything is
   * written, so the guard below covers the positions they land in too.
   */
  const rederived =
    options.rederiveCarriedLegs === false
      ? []
      : await planCarriedLegUpdates(deps, [...scopes.values()], (ledger) => [
          ...without(ledger, removed),
          ...edited,
        ]);
  for (const leg of rederived) touch(leg, leg.tradeDate);
  const replacing = new Set<string>([...removed, ...rederived.map((leg) => leg.id)]);
  const writes = [...edited.filter((t) => !rederived.some((leg) => leg.id === t.id)), ...rederived];

  // BR-006-15: each ledger must hold together with every edit in place.
  // `without` first, because an edit that only changes the quantity is a
  // replace, not an addition; a row moved away is simply absent from the
  // position it left, which is what can strand a sale there.
  for (const scope of scopes.values()) {
    const guard = await guardReplayable(deps, scope, (existing) => [
      ...without(existing, replacing),
      ...writes.filter(
        (t) => t.assetId === scope.assetId && t.institutionId === scope.institutionId,
      ),
    ]);
    if (!guard.ok) return guard;
  }

  for (const row of writes) await deps.transactions.update(row);

  const recalculations: RecalculationOutcome[] = [];
  for (const scope of scopes.values()) {
    const recalculated = await recalculatePositionFrom(deps, scope);
    if (!recalculated.ok) return recalculated;
    recalculations.push(recalculated.value);
  }

  return ok({
    transactions: pairs.map(
      (pair) => rederived.find((leg) => leg.id === pair.updated.id) ?? pair.updated,
    ),
    recalculations,
    rederived,
  });
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
    ...estimateAfterEdit(original, input, unitPrice),
    updatedAt: now,
  };
}

/**
 * SPEC-007 BR-007-06 / SPEC-005 BR-005-20d: "a user edit of the price clears
 * it". The price is the only thing the marker is about, so:
 *
 *   - an explicit `costEstimate` wins (import's own in-place writes);
 *   - a **user** edit (`flagUserModified` not `false`) that **changes** the
 *     price is the user stating it — the row becomes exact and its close date
 *     goes with the marker (the database CHECK pairs them);
 *   - anything else keeps the row's marker. The edit form submits every
 *     field, so a fees-only or date-only correction resubmits the estimated
 *     price unchanged; clearing on that would let an estimate the user never
 *     looked at read as exact — the failure DL-007-12 names. Nor does an
 *     import's own edit (a classification, a promotion) clear it: no one
 *     stated a price.
 */
function estimateAfterEdit(
  original: Transaction,
  input: EditTransactionInput,
  unitPrice: Money,
): Pick<Transaction, 'costIsEstimate' | 'estimateCloseDate'> {
  if (input.costEstimate !== undefined) {
    return input.costEstimate === null
      ? { costIsEstimate: false, estimateCloseDate: null }
      : { costIsEstimate: true, estimateCloseDate: input.costEstimate.closeDate };
  }
  if (input.flagUserModified !== false && !unitPrice.equals(original.unitPrice)) {
    return { costIsEstimate: false, estimateCloseDate: null };
  }
  return { costIsEstimate: original.costIsEstimate, estimateCloseDate: original.estimateCloseDate };
}

/**
 * SPEC-005 BR-005-17 (#110; amended #157 review F0) — an imported row whose
 * key is **not** derived from its own fields keeps that key while the B3 row
 * it records is still the same row. What "still the same row" checks
 * **differs by key form**, because the two seven-segment forms
 * `importNaturalKeyFor` produces (`stage-batch.ts`'s `keyFormsFor`) disagree
 * on whether the ledger type is part of the B3 row's identity or a decision
 * made about it:
 *
 * - **`unmapped`** — B3's movement type resolves to no `TransactionType` at
 *   all (`classifyMovement` returns `null`, or conversion evidence claims
 *   it), so staging keys it with `UNCLASSIFIED_PLACEHOLDER_TYPE` in the type
 *   slot: the key identifies *the B3 row*, never the type a later
 *   classification (or re-type) gives it. So re-typing such a row
 *   (bonificação → buy, say) must keep the key: it is still the same
 *   Atualização credit, decided differently. Before this fix, `naturalKeyFor`
 *   was compared against `original`'s **current** fields, which already
 *   reflect the earlier classification — so the check never recognised this
 *   form as what it was, and a type change (only) rederived a key no future
 *   import's staging (always keyed with the placeholder for a B3 type the
 *   map does not resolve) can ever recompute. The next import of the file
 *   then found no match, staged the credit fresh, and SPEC-005 BR-005-20d
 *   paired it with the exercise a **second** time: 50 shares held, a
 *   7-share credit re-typed bonificação → buy, and a re-import's second
 *   7-share subscription counted 64 shares against a real 57 (#157 review
 *   F0).
 * - **`priceless`** — B3's movement type *does* resolve (a price-less
 *   `Transferência` credit staged `unclassified` only for want of a price,
 *   BR-005-20a) — the key's type slot is the real, resolved type, so the
 *   type genuinely identifies which B3 row this is and stays part of the
 *   check, unchanged.
 *
 * Rederiving either key on a fees-only or price-only edit produced a key no
 * re-import computes, and the next import of the file wrote the row a second
 * time — the original #110 finding, unaffected by this fix.
 *
 * A manual row, and an imported row keyed by `naturalKeyFor` itself, are
 * untouched: for them this is never true, and BR-006-04 applies as before.
 */
function keepsImportKey(original: Transaction, input: EditTransactionInput): boolean {
  if (original.importBatchId === null) return false;

  // `importNaturalKeyFor` always appends exactly one segment to
  // `naturalKeyFor`'s six — the same structural read `storedB3TypeOf` uses
  // elsewhere to recover it. The `unmapped` form's type slot is always the
  // placeholder; a `priceless` form carries its resolved type, which is the
  // placeholder's own value only for a price-less `Rendimento` — kept here
  // too, harmlessly, since that key likewise records the B3 row, not a type.
  const segments = original.naturalKey.split('|');
  if (segments.length === 7 && segments[3] === UNCLASSIFIED_PLACEHOLDER_TYPE) {
    return (
      (input.assetId ?? original.assetId) === original.assetId &&
      (input.institutionId === undefined ? original.institutionId : input.institutionId) ===
        original.institutionId &&
      (input.tradeDate ?? original.tradeDate) === original.tradeDate &&
      (input.quantity ?? original.quantity).equals(original.quantity)
    );
  }

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
