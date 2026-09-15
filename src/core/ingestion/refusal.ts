import type { BusinessDate } from '@/core/shared/clock';
import type { UserId } from '@/core/shared/ids';
import { Quantity } from '@/core/shared/money';
import type { Transaction } from '@/core/ledger/transaction';
import { PositionErrorCode } from '@/core/positions/errors';
import { firstUnreplayable } from '@/core/positions/replay';
import { buildCandidate } from '@/core/ingestion/commit-batch';
import type { ImportRow } from '@/core/ingestion/ports';

/**
 * SPEC-005 BR-005-19/24, SPEC-006 BR-006-15 (#117) — why a committed row is
 * `invalid`, asked of the **current** ledger rather than frozen at commit.
 *
 * Derived, like the post-import summary, so it stays true: once the missing
 * history is imported the same row reads as applicable, and once a re-import
 * applied it, as applied. No column records a cause that could go stale.
 */
export type RowRefusal =
  /** The row's own fields are contradictory (`validateTransactionDraft`). */
  | { readonly kind: 'malformed' }
  /** It removes more than the position held on its date. */
  | {
      readonly kind: 'insufficient_quantity';
      readonly held: Quantity;
      readonly requested: Quantity;
      readonly date: BusinessDate;
    }
  /** It fits, but a later stored row would then no longer replay. */
  | { readonly kind: 'conflicts_with_ledger'; readonly date: BusinessDate }
  /** The ledger now accepts it: importing the file again applies it. */
  | { readonly kind: 'applicable' }
  /** The ledger already holds it, from another import. */
  | { readonly kind: 'applied' };

/** `ledger` is the stored ledger of the row's `(asset, institution)` position. */
export function explainRefusal(
  row: ImportRow,
  ledger: readonly Transaction[],
  userId: UserId,
  now: Date,
  today: BusinessDate,
): RowRefusal {
  if (
    ledger.some(
      (t) =>
        t.naturalKey === row.naturalKey &&
        t.occurrence === row.occurrence &&
        t.status !== 'superseded',
    )
  ) {
    return { kind: 'applied' };
  }
  const candidate = buildCandidate(row, row.batchId, userId, 'active', now, today);
  if (candidate === null) return { kind: 'malformed' };

  const failure = firstUnreplayable([...ledger, candidate]);
  if (failure === null) return { kind: 'applicable' };
  if (failure.transaction.id !== candidate.id) {
    return { kind: 'conflicts_with_ledger', date: failure.transaction.tradeDate };
  }
  if (failure.error.code !== PositionErrorCode.INSUFFICIENT_QUANTITY) return { kind: 'malformed' };
  return {
    kind: 'insufficient_quantity',
    held: Quantity.fromString(String(failure.error.context['held'])),
    requested: Quantity.fromString(String(failure.error.context['requested'])),
    date: candidate.tradeDate,
  };
}
