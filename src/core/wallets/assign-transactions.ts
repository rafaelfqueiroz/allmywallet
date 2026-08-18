import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, TransactionId, UserId, WalletId } from '@/core/shared/ids';
import { Quantity, sumQuantity } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import { LedgerErrorCode, ledgerError } from '@/core/ledger/errors';
import type { TransactionRepository } from '@/core/ledger/ports';
import type { Transaction } from '@/core/ledger/transaction';
import { allocateToWallet } from '@/core/wallets/allocate';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import { WalletErrorCode, walletError } from '@/core/wallets/errors';

/**
 * SPEC-006 BR-006-17's other half — "bulk operations: delete multiple,
 * **assign multiple to a wallet**" — which SPEC-006 explicitly delegates here
 * ("bulk assignment here delegates to it", Out of Scope).
 *
 * ---------------------------------------------------------------------------
 * WHAT "ASSIGN A TRANSACTION TO A WALLET" CAN MEAN
 *
 * It cannot mean what it says. SPEC-010's allocation model (DM-2) is one row
 * per `(user, wallet, asset)` carrying a **quantity** — there is no such thing
 * as an allocated transaction, and DL-010-05 is explicit that a share carries
 * no record of which purpose it served. So a selection of rows has to be read
 * as a statement about quantity, and the only honest reading is the one the
 * rest of SPEC-010 already uses:
 *
 *   *the shares these transactions brought in belong in this wallet.*
 *
 * That is `mode: 'add'` — the same intent as `allocateAction`'s resolve-a-
 * pending-item form, and for the same reason `allocate.ts` spells out at
 * length: reading a remainder as an absolute target silently overwrites the
 * wallet's existing slice. A buy leaves its shares unallocated on purpose
 * (BR-010-11 refuses to guess a wallet), so they sit in the Needs attention
 * queue; selecting those rows and naming a wallet is the user answering the
 * question the queue asked, in bulk.
 *
 * **Reducing rows in the selection net off rather than being ignored.** A
 * selection covering a buy of 100 and a later sale of 30 brought in 70, and
 * assigning 100 of them would claim shares that are no longer held. The sign
 * rules are `apply-ledger-effects.ts`'s, imported wholesale rather than
 * restated, so the two cannot drift on the fourteenth type.
 *
 * **The requested quantity is clamped to what is actually unassigned**, and
 * the clamp is computed *under the allocation lock* (see `lockForAsset` in
 * `ports.ts`) so it cannot be stale by the time the write happens. Clamping
 * rather than refusing is the difference between "we assigned the 20 shares
 * that were free" and an error the user cannot act on — but it is reported,
 * never silent: every asset the selection did not fully place comes back in
 * `skipped`, so the caller can say so.
 * ---------------------------------------------------------------------------
 */

/**
 * `WalletDependencies` plus the one ledger read this needs. Declared as a
 * `Pick` rather than the whole `TransactionRepository`: this use case has no
 * business listing or writing the ledger, and the narrow type says so.
 */
export interface AssignTransactionsDependencies extends WalletDependencies {
  readonly transactions: Pick<TransactionRepository, 'findById'>;
}

export interface AssignTransactionsInput {
  readonly walletId: WalletId;
  readonly transactionIds: readonly TransactionId[];
}

export interface AssetAssignment {
  readonly assetId: AssetId;
  /** What actually landed in the wallet, after the unassigned clamp. */
  readonly quantity: Quantity;
}

export type SkipReason =
  /** Every share the selection brought in is already in some wallet. */
  | 'already_assigned'
  /** The selection's net effect on this asset is zero or negative. */
  | 'no_quantity';

export interface SkippedAsset {
  readonly assetId: AssetId;
  readonly reason: SkipReason;
}

export interface AssignTransactionsResult {
  readonly walletId: WalletId;
  readonly assigned: readonly AssetAssignment[];
  readonly skipped: readonly SkippedAsset[];
}

export async function assignTransactionsToWallet(
  deps: AssignTransactionsDependencies,
  userId: UserId,
  input: AssignTransactionsInput,
): Promise<Result<AssignTransactionsResult, DomainError>> {
  if (input.transactionIds.length === 0) {
    return err(ledgerError(LedgerErrorCode.EMPTY_SELECTION, { operation: 'bulk_assign' }));
  }

  const wallet = await deps.wallets.findById(input.walletId);
  if (wallet === null || wallet.userId !== userId) {
    return err(walletError(WalletErrorCode.WALLET_NOT_FOUND, { walletId: input.walletId }));
  }

  const targets: Transaction[] = [];
  for (const id of input.transactionIds) {
    const found = await deps.transactions.findById(id);
    if (found === null) {
      return err(ledgerError(LedgerErrorCode.TRANSACTION_NOT_FOUND, { transactionId: id }));
    }
    targets.push(found);
  }

  const assigned: AssetAssignment[] = [];
  const skipped: SkippedAsset[] = [];

  for (const [assetId, net] of netQuantityByAsset(targets)) {
    if (!net.isPositive()) {
      skipped.push({ assetId, reason: 'no_quantity' });
      continue;
    }

    /**
     * BR-010-05's lock, taken here rather than left to `allocateToWallet`,
     * because the clamp below is a *read* that the write depends on. Postgres
     * row locks are re-entrant within a transaction, so the lock
     * `allocateToWallet` takes a moment later is the same one — and both run
     * inside the caller's single `withTenant` transaction (AR-11).
     */
    const locked = await deps.allocations.lockForAsset(assetId);
    const held = await deps.positionQuery.query(assetId);
    const allocated = sumQuantity(locked.map((allocation) => allocation.quantity));
    const unassigned = held.quantity.minus(allocated);

    if (!unassigned.isPositive()) {
      skipped.push({ assetId, reason: 'already_assigned' });
      continue;
    }

    const quantity = unassigned.comparedTo(net) < 0 ? unassigned : net;

    const result = await allocateToWallet(deps, userId, {
      walletId: input.walletId,
      assetId,
      mode: 'add',
      quantity,
    });
    if (!result.ok) return result;

    assigned.push({ assetId, quantity });
    if (quantity.comparedTo(net) < 0) {
      skipped.push({ assetId, reason: 'already_assigned' });
    }
  }

  return ok({ walletId: input.walletId, assigned, skipped });
}

/**
 * BR-006-03 / DL-006-06: only `active` rows enter calculations, and an
 * allocation is a calculation over the same ledger — an `unclassified` row is
 * stored deliberately and inert deliberately.
 *
 * The sign rules are `apply-ledger-effects.ts`'s, imported rather than
 * restated: an `adjustment` carries its direction in the sign of its quantity
 * (SPEC-005 BR-005-24), which is why it cannot be read from the type alone.
 */
function netQuantityByAsset(targets: readonly Transaction[]): ReadonlyMap<AssetId, Quantity> {
  const totals = new Map<AssetId, Quantity>();
  for (const transaction of targets) {
    if (transaction.status !== 'active') continue;
    const effect = quantityEffect(transaction);
    if (effect === null) continue;
    totals.set(
      transaction.assetId,
      (totals.get(transaction.assetId) ?? Quantity.zero()).plus(effect),
    );
  }
  return totals;
}

/** Null for a row that moves no shares — a dividend, a JCP, a rendimento. */
function quantityEffect(transaction: Transaction): Quantity | null {
  switch (transaction.type) {
    case 'buy':
    case 'transfer_in':
    case 'subscription':
    case 'bonificacao':
      return transaction.quantity;
    case 'sell':
    case 'transfer_out':
      return transaction.quantity.negated();
    /**
     * Deliberately absent: `split` and `grupamento` scale a holding rather
     * than adding to it, and `apply-corporate-event.ts` already scales the
     * allocations themselves. Counting a 1:2 split as "brought in 100 shares"
     * would assign shares the event had already placed.
     */
    case 'adjustment':
      return transaction.quantity;
    default:
      return null;
  }
}
