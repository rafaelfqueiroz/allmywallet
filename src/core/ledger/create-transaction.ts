import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, ImportBatchId, InstitutionId, UserId } from '@/core/shared/ids';
import { TransactionId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
import { type Result, ok } from '@/core/shared/result';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import { guardReplayable } from '@/core/ledger/guard-replayable';
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
 * SPEC-006 BR-006-11: a transaction can be created manually with type, asset,
 * date, quantity, unit price, fees and institution.
 *
 * Manual entry is not a convenience feature. B3 extracts do not carry a CDB
 * bought at a bank, and they start at whatever date the user's export range
 * begins — so without this path those holdings do not exist in the product at
 * all (the spec's "a CDB absent from every B3 extract" acceptance criterion).
 * SPEC-005's import commit uses the same use case, passing `importBatchId`.
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
}

export interface CreateTransactionResult {
  readonly transaction: Transaction;
  readonly recalculation: RecalculationOutcome;
}

export async function createTransaction(
  deps: LedgerDependencies,
  userId: UserId,
  input: CreateTransactionInput,
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

  const naturalKey = naturalKeyFor({
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
    naturalKey,
    // BR-006-04 / TS-21: two genuinely identical same-day trades are real, so
    // uniqueness is on `(natural_key, occurrence)` and the second one gets 2.
    occurrence: await deps.transactions.nextOccurrence(naturalKey),
    importBatchId: input.importBatchId ?? null,
    isManual: (input.importBatchId ?? null) === null,
    isUserModified: false,
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
  const guard = await guardReplayable(deps, candidate, (existing) => [...existing, candidate]);
  if (!guard.ok) return guard;

  await deps.transactions.insert(candidate);

  const recalculation = await recalculatePositionFrom(deps, {
    assetId: candidate.assetId,
    institutionId: candidate.institutionId,
    fromDate: candidate.tradeDate,
  });
  if (!recalculation.ok) return recalculation;

  return ok({ transaction: candidate, recalculation: recalculation.value });
}
