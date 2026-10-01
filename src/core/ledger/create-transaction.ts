import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, ImportBatchId, InstitutionId, UserId } from '@/core/shared/ids';
import { TransactionId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
import { type Result, ok } from '@/core/shared/result';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import { planCarriedLegUpdates } from '@/core/ledger/carried-legs';
import { guardReplayable, without } from '@/core/ledger/guard-replayable';
import { positionKeyString } from '@/core/positions/replay';
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
 * SPEC-006 BR-006-11: a transaction can be created manually with type, asset,
 * date, quantity, unit price, fees and institution.
 *
 * Manual entry is not a convenience feature. B3 extracts do not carry a CDB
 * bought at a bank, and they start at whatever date the user's export range
 * begins — so without this path those holdings do not exist in the product at
 * all (the spec's "a CDB absent from every B3 extract" acceptance criterion).
 * SPEC-005's classification of an ignored row uses this path, passing
 * `importBatchId`; import commit resolves and writes its batch separately.
 */

export interface CreateTransactionInput {
  readonly assetId: AssetId;
  readonly institutionId: InstitutionId | null;
  readonly type: TransactionType;
  /** BR-006-03. Defaults to `active`; SPEC-005 passes `unclassified`. */
  readonly status?: TransactionStatus | undefined;
  readonly tradeDate: BusinessDate;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly fees: Money;
  /** SPEC-007 BR-007-04 — split and grupamento only. */
  readonly ratio?: Quantity | null | undefined;
  /** BR-006-02: provenance. Null means manual entry. */
  readonly importBatchId?: ImportBatchId | null | undefined;
  /**
   * SPEC-005 BR-005-17 (#110) — the key and occurrence staging gave an import
   * row, kept so that re-importing the same file finds this transaction and
   * reports the row as a duplicate. Omitted for manual entry.
   */
  readonly importKey?: { readonly naturalKey: string; readonly occurrence: number } | undefined;
}

export interface CreateTransactionResult {
  readonly transaction: Transaction;
  /** The created row's position, retained for single-position callers. */
  readonly recalculation: RecalculationOutcome;
  /** Every affected position, including positions reached by carried legs. */
  readonly recalculations: readonly RecalculationOutcome[];
  /** SPEC-007 BR-007-06: downstream carried costs and markers re-derived together. */
  readonly rederived: readonly Transaction[];
}

export interface CreateTransactionOptions {
  /**
   * SPEC-006 BR-006-16 / SPEC-005 BR-005-20: a human classification owns
   * its figure from the outset, including while carries are planned. Defaults
   * to false for ordinary creation and automatic import writes.
   */
  readonly flagUserModified?: boolean;
  /** SPEC-005 BR-005-20a: batch callers resolving carries themselves opt out. */
  readonly rederiveCarriedLegs?: boolean;
}

export async function createTransaction(
  deps: LedgerDependencies,
  userId: UserId,
  input: CreateTransactionInput,
  options: CreateTransactionOptions = {},
): Promise<Result<CreateTransactionResult, DomainError>> {
  const ratio = input.ratio ?? null;
  const status = input.status ?? 'active';

  const validation = validateTransactionDraft(
    {
      type: input.type,
      tradeDate: input.tradeDate,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      fees: input.fees,
      ratio,
    },
    deps.clock.today(),
  );
  if (!validation.ok) return validation;

  const naturalKey =
    input.importKey?.naturalKey ??
    naturalKeyFor({
      assetId: input.assetId,
      institutionId: input.institutionId,
      type: input.type,
      tradeDate: input.tradeDate,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
    });

  const now = deps.clock.now();
  const candidate: Transaction = {
    id: TransactionId.generate(),
    userId,
    assetId: input.assetId,
    institutionId: input.institutionId,
    type: input.type,
    status,
    tradeDate: input.tradeDate,
    quantity: input.quantity,
    unitPrice: input.unitPrice,
    fees: input.fees,
    totalValue: computeTotalValue(input.type, input.quantity, input.unitPrice, input.fees),
    ratio,
    // SPEC-006 BR-006-05 / SPEC-007 BR-007-05b: manual single-row entry
    // never creates half of an asset conversion. The grouped import/manual
    // conversion use case supplies these fields atomically.
    conversionGroupId: null,
    costBasis: null,
    naturalKey,
    // BR-006-04 / TS-21: two genuinely identical same-day trades are real, so
    // uniqueness is on `(natural_key, occurrence)` and the second one gets 2.
    occurrence: input.importKey?.occurrence ?? (await deps.transactions.nextOccurrence(naturalKey)),
    importBatchId: input.importBatchId ?? null,
    isManual: (input.importBatchId ?? null) === null,
    isUserModified: options.flagUserModified === true,
    // SPEC-007 BR-007-06 / SPEC-005 BR-005-20d: manual single-row entry never
    // creates an estimate — only the import/reconciliation path can classify
    // a row that way.
    costIsEstimate: false,
    estimateCloseDate: null,
    createdAt: now,
    updatedAt: now,
  };

  /**
   * SPEC-006 BR-006-15's headline guard, and the reason this spec and SPEC-007
   * land together: "selling more than the quantity held **at that date**".
   *
   * It is answered by replaying the candidate ledger rather than by comparing
   * against a cached position, because the row may be **backdated**
   * (BR-006-18). A sell inserted between two existing trades has to be legal
   * at its own date *and* leave every later row still legal — comparing it
   * against today's holdings would wave through a sale that makes next
   * month's sale impossible.
   */
  const ownScope: RecalculationScope = {
    assetId: candidate.assetId,
    institutionId: candidate.institutionId,
    fromDate: candidate.tradeDate,
  };
  // SPEC-006 BR-006-18 / SPEC-007 BR-007-06: an insertion changes the
  // cost and estimate marker later transfers and conversions carried away.
  // Plan against the projected ledger before guarding or writing any row.
  const rederived =
    options.rederiveCarriedLegs === false
      ? []
      : await planCarriedLegUpdates(deps, [ownScope], (ledger) => [...ledger, candidate]);
  const transaction = rederived.find((leg) => leg.id === candidate.id) ?? candidate;
  const writes = [transaction, ...rederived.filter((leg) => leg.id !== candidate.id)];
  const replacing = new Set<string>(rederived.map((leg) => leg.id));
  const scopes = new Map<string, RecalculationScope>([[positionKeyString(ownScope), ownScope]]);
  for (const leg of rederived) {
    const id = positionKeyString(leg);
    const previous = scopes.get(id);
    scopes.set(id, {
      assetId: leg.assetId,
      institutionId: leg.institutionId,
      fromDate:
        previous === undefined || leg.tradeDate < previous.fromDate
          ? leg.tradeDate
          : previous.fromDate,
    });
  }

  // SPEC-006 BR-006-15: every affected position must replay with all the
  // re-derived legs in place; a refusal must precede the first insert/update.
  for (const scope of scopes.values()) {
    const guard = await guardReplayable(deps, scope, (existing) => [
      ...without(existing, replacing),
      ...writes.filter(
        (row) => row.assetId === scope.assetId && row.institutionId === scope.institutionId,
      ),
    ]);
    if (!guard.ok) return guard;
  }

  await deps.transactions.insert(transaction);
  for (const leg of rederived) {
    if (leg.id !== candidate.id) await deps.transactions.update(leg);
  }

  const recalculation = await recalculatePositionFrom(
    deps,
    scopes.get(positionKeyString(ownScope)) ?? ownScope,
  );
  if (!recalculation.ok) return recalculation;
  const recalculations = [recalculation.value];
  for (const scope of scopes.values()) {
    if (positionKeyString(scope) === positionKeyString(ownScope)) continue;
    const outcome = await recalculatePositionFrom(deps, scope);
    if (!outcome.ok) return outcome;
    recalculations.push(outcome.value);
  }

  return ok({ transaction, recalculation: recalculation.value, recalculations, rederived });
}
