import type { TransactionId } from '@/core/shared/ids';
import { pairTransfers, type TransferLeg } from '@/core/ingestion/transfer-cost';
import { naturalKeyFor } from '@/core/ledger/natural-key';
import { isActive, type Transaction } from '@/core/ledger/transaction';

/**
 * SPEC-005 BR-005-20a, read over the **stored ledger** — which `transfer_in`
 * came from which `transfer_out`.
 *
 * The relation itself is `pairTransfers` (`core/ingestion/transfer-cost.ts`),
 * unchanged: same asset, trade date and quantity, a debit at a known
 * institution, one-to-one on both sides, plus the #145 same-position round
 * trip. What this module adds is only how a stored row becomes a
 * `TransferLeg`, so the two readers of the stored ledger — the carried-leg
 * re-derivation (`carried-legs.ts`, SPEC-007 BR-007-06) and the snapshot's
 * flow fold (SPEC-013 BR-013-08, `core/valuation/snapshot.ts`) — agree on
 * cost-carry pairs. `internalLedgerTransferIds` separately recognises the
 * flow-only round trips required by DL-013-11, without changing cost carry.
 */

/** Written by import and never edited by a user (BR-006-16). */
export function isImportOwned(transaction: Transaction): boolean {
  return transaction.importBatchId !== null && !transaction.isManual && !transaction.isUserModified;
}

/**
 * A `transfer_in` that took its cost by carry rather than from a stated price.
 *
 * Import keys such a credit at the price B3 stated — none — while it stores
 * the carried cost (SPEC-005 BR-005-17, `keepsImportKey` in
 * `edit-transaction.ts`), so its key is not the one its own fields derive. A
 * priced B3 credit is keyed at its own price and never matches. A carried cost
 * is always positive (`resolveCarriedCosts` carries no zero average), so the
 * two keys can never coincide by accident.
 */
export function isCarriedCredit(transaction: Transaction): boolean {
  return (
    transaction.type === 'transfer_in' &&
    isImportOwned(transaction) &&
    transaction.naturalKey !== naturalKeyFor(transaction)
  );
}

/**
 * Every one-to-one debit↔credit pair over the ledger's `active` rows, keyed by
 * the credit's id with the debit's id as value.
 *
 * `priceStated` is the one fact a stored row does not carry directly; it is
 * read as "not a carried credit" (`isCarriedCredit`), exactly as the carried-leg
 * re-derivation always has. It matters only to the #145 round trip, which
 * pairs nothing when a credit carries a price of its own.
 *
 * **Cut-invariant.** A pair's legs share one trade date, and so does every leg
 * that could compete with them, so pairing the whole ledger and pairing the
 * ledger cut at any date give the same pairs on or before that date — which is
 * what lets a snapshot built from scratch and one carried forward agree
 * (DM-4).
 */
export function pairLedgerTransfers(
  transactions: readonly Transaction[],
): ReadonlyMap<TransactionId, TransactionId> {
  const active = transactions.filter(isActive);
  const legOf = (transaction: Transaction): TransferLeg => ({
    id: transaction.id,
    assetId: transaction.assetId,
    institutionId: transaction.institutionId,
    tradeDate: transaction.tradeDate,
    quantity: transaction.quantity,
    priceStated: !isCarriedCredit(transaction),
  });
  const pairs = pairTransfers(
    active.filter((t) => t.type === 'transfer_in').map(legOf),
    active.filter((t) => t.type === 'transfer_out').map(legOf),
  );
  // The ids went in as transaction ids and come back unchanged.
  return pairs as ReadonlyMap<TransactionId, TransactionId>;
}

/**
 * SPEC-013 BR-013-08 / DL-013-11: the legs that move no money. Cost-carry
 * pairs remain authoritative; a same-position round trip is also internal
 * regardless of stated prices, import ownership or user edits.
 *
 * Round trips require a known institution and equal occurrence counts for
 * one asset, institution, date and exact quantity. Two debits of 3 and two
 * credits of 3 are internal; two debits against one credit are not. Choosing
 * which debit or differently priced credit to cancel would invent a residual
 * cost flow. Nor do we aggregate 3 + 3 against 6: equal totals alone do not
 * establish the same-quantity relation the spec names.
 *
 * Worked example (DV-17): buy 3 for 10,00; two credits of 3 at 3,33333333
 * and 3,50, and two debits of 3 at the same custodian/date add zero to both
 * flow columns. Total invested remains 10,00, whatever cost the replayed lot
 * now carries. All competing occurrences share a date, so this classification
 * is cut-invariant and preserves rebuild-equals-incremental (DM-4).
 */
export function internalLedgerTransferIds(
  transactions: readonly Transaction[],
): ReadonlySet<TransactionId> {
  const internal = new Set<TransactionId>();
  for (const [credit, debit] of pairLedgerTransfers(transactions)) {
    internal.add(credit);
    internal.add(debit);
  }

  const groups = new Map<string, { credits: TransactionId[]; debits: TransactionId[] }>();
  for (const transaction of transactions) {
    if (
      !isActive(transaction) ||
      transaction.institutionId === null ||
      internal.has(transaction.id) ||
      (transaction.type !== 'transfer_in' && transaction.type !== 'transfer_out')
    ) {
      continue;
    }
    const key = [
      transaction.assetId,
      transaction.institutionId,
      transaction.tradeDate,
      transaction.quantity.toString(),
    ].join('|');
    let group = groups.get(key);
    if (group === undefined) {
      group = { credits: [], debits: [] };
      groups.set(key, group);
    }
    if (transaction.type === 'transfer_in') group.credits.push(transaction.id);
    else group.debits.push(transaction.id);
  }
  for (const { credits, debits } of groups.values()) {
    if (credits.length !== debits.length) continue;
    for (const id of [...credits, ...debits]) internal.add(id);
  }
  return internal;
}
