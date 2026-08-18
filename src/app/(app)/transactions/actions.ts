'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId, InstitutionId, TransactionId, WalletId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { Result } from '@/core/shared/result';
import type { DomainError } from '@/core/shared/domain-error';
import { ASSET_CLASSES } from '@/db/schema/assets';
import { createTransaction } from '@/core/ledger/create-transaction';
import { editTransaction } from '@/core/ledger/edit-transaction';
import { bulkDeleteTransactions } from '@/core/ledger/bulk-delete-transactions';
import { deleteTransaction } from '@/core/ledger/delete-transaction';
import { TRANSACTION_TYPES } from '@/core/ledger/transaction';
import { applyLedgerEffects } from '@/core/wallets/apply-ledger-effects';
import { assignTransactionsToWallet } from '@/core/wallets/assign-transactions';
import { reconcileAllocationsToHoldings } from '@/core/wallets/reconcile-allocations';
import {
  IDLE,
  INVALID_INPUT,
  failure,
  type ActionState,
} from '@/app/(app)/transactions/action-state';
import {
  withTransactionWriteDeps,
  type TransactionWriteDeps,
} from '@/app/(app)/transactions/composition';
import { normalizeDecimalInput } from '@/lib/decimal-input';
import { requireUserId } from '@/lib/session';

/**
 * SPEC-006 BR-006-11..17 — the write side of the ledger.
 *
 * AR-32: each action validates with Zod at the boundary (DV-07), resolves the
 * session, and calls one use case. AR-35: nothing here decides anything —
 * every rule below is a `core/ledger` or `core/wallets` call, and the shape of
 * these functions is "parse, dispatch, revalidate".
 *
 * **Every action returns `ActionState` rather than `void`**, unlike
 * `(app)/wallets/actions.ts`. See `action-state.ts`: BR-006-15 requires the
 * refusal to explain itself, and a `void` action has nowhere to put the
 * explanation.
 *
 * **Allocations move in the same transaction as the ledger** (AR-11/AR-19). A
 * row that arrives goes through `applyLedgerEffects`; a row that changes or
 * leaves goes through `reconcileAllocationsToHoldings`, because a deletion
 * produces nothing to fold and would otherwise leave BR-010-05's sum invariant
 * broken with no retry that repairs it.
 */

const decimal = z
  .string()
  .transform((value) => normalizeDecimalInput(value))
  .refine((value): value is string => value !== null, 'not a decimal literal');

/** Optional decimal: an empty field is "not supplied", not "zero". */
const optionalDecimal = z
  .string()
  .optional()
  .transform((value) => (value === undefined ? null : normalizeDecimalInput(value)));

const optionalId = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? null : value.trim()));

const optionalText = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? null : value.trim()));

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * BR-006-11's asset, and the spec's "a CDB absent from every B3 extract"
 * criterion in one field group: either an id picked from the catalogue, or a
 * code/name/class for something the catalogue has never heard of. Both are
 * always present in the form (no JavaScript reveals either), and a typed code
 * wins — it is the more specific statement of intent.
 */
const AssetChoiceSchema = z.object({
  assetId: optionalId,
  assetCode: optionalText,
  assetName: optionalText,
  assetClass: z.enum(ASSET_CLASSES).optional(),
});

const InstitutionChoiceSchema = z.object({
  institutionId: optionalId,
  institutionName: optionalText,
});

const TransactionFieldsSchema = z.object({
  type: z.enum(TRANSACTION_TYPES),
  tradeDate: isoDate,
  quantity: decimal,
  unitPrice: decimal,
  fees: optionalDecimal,
  ratio: optionalDecimal,
});

const CreateSchema =
  TransactionFieldsSchema.merge(AssetChoiceSchema).merge(InstitutionChoiceSchema);

export async function createTransactionAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = CreateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return INVALID_INPUT;
  const input = parsed.data;

  const outcome = await withTransactionWriteDeps(userId, async (deps) => {
    const assetId = await resolveAsset(deps, input);
    if (assetId === null) return INVALID_INPUT;
    const institutionId = await resolveInstitution(deps, input);

    const created = await createTransaction(deps.ledger, userId, {
      assetId,
      institutionId,
      type: input.type,
      tradeDate: BusinessDate.of(input.tradeDate),
      quantity: Quantity.fromString(input.quantity),
      unitPrice: Money.fromString(input.unitPrice),
      fees: Money.fromString(input.fees ?? '0'),
      ratio: input.ratio === null ? null : Quantity.fromString(input.ratio),
    });
    if (!created.ok) return failure(created.error);

    // BR-010-10/16: the new row's effect on allocations — an auto-increment
    // for a single-wallet asset, nothing at all for a split one, a
    // proportional reduction for a sale.
    const effects = await applyLedgerEffects(deps.assign, userId, [created.value.transaction]);
    if (!effects.ok) return failure(effects.error);

    return IDLE;
  });

  if (outcome.status === 'error') return outcome;
  revalidateLedger();
  redirect('/transactions');
}

const EditSchema = TransactionFieldsSchema.merge(AssetChoiceSchema)
  .merge(InstitutionChoiceSchema)
  .extend({ transactionId: z.string() });

export async function editTransactionAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = EditSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return INVALID_INPUT;
  const input = parsed.data;

  const outcome = await withTransactionWriteDeps(userId, async (deps) => {
    const assetId = await resolveAsset(deps, input);
    if (assetId === null) return INVALID_INPUT;
    const institutionId = await resolveInstitution(deps, input);

    const edited = await editTransaction(deps.ledger, TransactionId.of(input.transactionId), {
      assetId,
      institutionId,
      type: input.type,
      tradeDate: BusinessDate.of(input.tradeDate),
      quantity: Quantity.fromString(input.quantity),
      unitPrice: Money.fromString(input.unitPrice),
      fees: Money.fromString(input.fees ?? '0'),
      ratio: input.ratio === null ? null : Quantity.fromString(input.ratio),
    });
    if (!edited.ok) return failure(edited.error);

    /**
     * Both positions the edit touched (`recalculations` is two entries when
     * the row moved asset or institution), because either can now hold fewer
     * shares than its wallets claim.
     */
    return reconcile(
      deps,
      userId,
      edited.value.recalculations.map((each) => each.scope.assetId),
    );
  });

  if (outcome.status === 'error') return outcome;
  revalidateLedger();
  redirect('/transactions');
}

const TransactionIdSchema = z.object({ transactionId: z.string() });

export async function deleteTransactionAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = TransactionIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return INVALID_INPUT;
  const id = TransactionId.of(parsed.data.transactionId);

  const outcome = await withTransactionWriteDeps(userId, async (deps) => {
    const target = await deps.ledger.transactions.findById(id);
    const deleted = await deleteTransaction(deps.ledger, id);
    if (!deleted.ok) return failure(deleted.error);
    return reconcile(deps, userId, target === null ? [] : [target.assetId]);
  });

  if (outcome.status === 'error') return outcome;
  revalidateLedger();
  redirect('/transactions');
}

/**
 * BR-006-17. The two bulk operations share one form and one multi-selection —
 * `<button name="operation" value="...">` says which was pressed, so a user
 * selects rows once and chooses what to do with them afterwards, rather than
 * picking the operation first and then being asked to select.
 */
const BulkSchema = z.object({
  operation: z.enum(['delete', 'assign']),
  walletId: optionalId,
});

export async function bulkTransactionsAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = BulkSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return INVALID_INPUT;

  const ids = formData
    .getAll('selected')
    .filter((value): value is string => typeof value === 'string')
    .map((value) => TransactionId.of(value));

  const outcome = await withTransactionWriteDeps(userId, async (deps) => {
    if (parsed.data.operation === 'assign') {
      if (parsed.data.walletId === null) return INVALID_INPUT;
      const assigned = await assignTransactionsToWallet(deps.assign, userId, {
        walletId: WalletId.of(parsed.data.walletId),
        transactionIds: ids,
      });
      return assigned.ok ? IDLE : failure(assigned.error);
    }

    // The assets have to be read *before* the rows are gone; after the delete
    // there is nothing left to say which positions changed.
    const touched: string[] = [];
    for (const id of ids) {
      const found = await deps.ledger.transactions.findById(id);
      if (found !== null) touched.push(found.assetId);
    }

    const deleted = await bulkDeleteTransactions(deps.ledger, ids);
    if (!deleted.ok) return failure(deleted.error);
    return reconcile(deps, userId, touched);
  });

  if (outcome.status === 'error') return outcome;
  revalidateLedger();
  redirect('/transactions');
}

/**
 * BR-010-05 after a ledger row changed or left. Returns an `ActionState` so
 * the three callers above read as one expression.
 */
async function reconcile(
  deps: TransactionWriteDeps,
  userId: Parameters<typeof reconcileAllocationsToHoldings>[1],
  assetIds: readonly string[],
): Promise<ActionState> {
  const reconciled = await reconcileAllocationsToHoldings(
    deps.assign,
    userId,
    assetIds.map((each) => AssetId.of(each)),
  );
  return toState(reconciled);
}

function toState(result: Result<unknown, DomainError>): ActionState {
  return result.ok ? IDLE : failure(result.error);
}

/**
 * A typed code wins over the catalogue selection — see `AssetChoiceSchema`.
 * Null means the form supplied neither, which the `required` attributes make
 * unreachable from the form itself.
 */
async function resolveAsset(
  deps: TransactionWriteDeps,
  input: z.infer<typeof AssetChoiceSchema>,
): Promise<AssetId | null> {
  if (input.assetCode !== null) {
    return deps.assets.resolve({
      code: input.assetCode.toUpperCase(),
      name: input.assetName ?? input.assetCode.toUpperCase(),
      assetClass: input.assetClass ?? 'stock',
    });
  }
  return input.assetId === null ? null : AssetId.of(input.assetId);
}

/** BR-007-08: null is a distinct bucket — "held directly", not a wildcard. */
async function resolveInstitution(
  deps: TransactionWriteDeps,
  input: z.infer<typeof InstitutionChoiceSchema>,
): Promise<InstitutionId | null> {
  if (input.institutionName !== null) return deps.institutions.resolve(input.institutionName);
  return input.institutionId === null ? null : InstitutionId.of(input.institutionId);
}

/**
 * BR-006-14: "affected reports refresh". Positions, valuations and every
 * report figure derive from the ledger, so a write invalidates all of them —
 * not merely the list the user is looking at.
 */
function revalidateLedger(): void {
  revalidatePath('/transactions');
  revalidatePath('/wallets');
  revalidatePath('/reports/patrimonio');
  revalidatePath('/reports/performance');
}
