import type { BusinessDate } from '@/core/shared/clock';
import type { UserId } from '@/core/shared/ids';
import { Quantity } from '@/core/shared/money';
import type { Transaction } from '@/core/ledger/transaction';
import { PositionErrorCode } from '@/core/positions/errors';
import { firstUnreplayable } from '@/core/positions/replay';
import { buildCandidate } from '@/core/ingestion/commit-batch';
import { corporateEventMovementOfKey } from '@/core/ingestion/corporate-event-resolution';
import type { ImportRow } from '@/core/ingestion/ports';

/**
 * SPEC-005 BR-005-24 — the likely cause of an `insufficient_quantity`
 * refusal, in the order this rule states them: an uncaptured corporate
 * event first (the position's ledger already has evidence of one),
 * unclassified rows next (something on the position was never classified,
 * but none of it is a corporate event), and missing history last (nothing
 * unclassified sits on the position at all, so the shortfall traces to
 * history that predates what was imported). `null` when none of the three
 * is determinable.
 */
export type InsufficientQuantityCause =
  'uncaptured_corporate_event' | 'unclassified_rows' | 'missing_history' | null;

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
      /** SPEC-005 BR-005-24: the likely explanation, read off the same ledger. */
      readonly likelyCause: InsufficientQuantityCause;
    }
  /** It fits, but a later stored row would then no longer replay. */
  | { readonly kind: 'conflicts_with_ledger'; readonly date: BusinessDate }
  /**
   * SPEC-005 BR-005-20a (#135) — a `transfer_out` whose same-position credit
   * is still `unclassified` for want of a carried cost. Applying it alone
   * empties the position; the two legs are written together or not at all.
   */
  | { readonly kind: 'unresolved_transfer_pair'; readonly date: BusinessDate }
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
  // BR-005-20a (#135): asked only of a row the ledger would otherwise accept,
  // because that is what a held-back debit is — it replays perfectly well, and
  // that is exactly the problem. A row refused for any other reason keeps the
  // refusal that names its own figures (review finding 3). Derived like every
  // other kind here, so once the credit takes its cost the same row reads as
  // `applicable` and a re-import applies it.
  if (failure === null) {
    return candidate.type === 'transfer_out' && hasUnresolvedCounterpart(ledger, candidate)
      ? { kind: 'unresolved_transfer_pair', date: candidate.tradeDate }
      : { kind: 'applicable' };
  }
  if (failure.transaction.id !== candidate.id) {
    return { kind: 'conflicts_with_ledger', date: failure.transaction.tradeDate };
  }
  if (failure.error.code !== PositionErrorCode.INSUFFICIENT_QUANTITY) return { kind: 'malformed' };
  return {
    kind: 'insufficient_quantity',
    held: Quantity.fromString(String(failure.error.context['held'])),
    requested: Quantity.fromString(String(failure.error.context['requested'])),
    date: candidate.tradeDate,
    likelyCause: likelyCauseOf(ledger),
  };
}

/**
 * SPEC-005 BR-005-20a (#135) — the credit of this debit's same-position pair,
 * still `unclassified`. `ledger` is already the row's own `(asset,
 * institution)` position, so date and quantity are all that is left to match —
 * the same relation `pairTransfers` forms, read one position at a time.
 */
function hasUnresolvedCounterpart(ledger: readonly Transaction[], debit: Transaction): boolean {
  return ledger.some(
    (t) =>
      t.type === 'transfer_in' &&
      t.status === 'unclassified' &&
      t.tradeDate === debit.tradeDate &&
      t.quantity.equals(debit.quantity),
  );
}

/**
 * SPEC-005 BR-005-24 — "unclassified rows affecting that asset" reads the
 * **ledger's** `unclassified` transactions on this position, not the
 * Posição batch's own rows (`buildReconciliation`'s
 * `hasUnclassifiedRowsAffectingAsset` does the analogous read for a
 * discrepancy). `listForPosition` already returns every status
 * (`core/ledger/ports.ts`), so `ledger` here already carries them — no
 * second query.
 *
 * A stored `unclassified` row keeps its unmapped natural key even once
 * classified by hand or resolved (BR-005-17), so `corporateEventMovementOfKey`
 * — the same reader `commit-batch.ts` uses to find a corporate-event row's
 * still-open partners — is what tells a Desdobro/Grupamento/Fração apart
 * from any other unclassified row.
 */
function likelyCauseOf(ledger: readonly Transaction[]): InsufficientQuantityCause {
  const unclassified = ledger.filter((t) => t.status === 'unclassified');
  if (unclassified.some((t) => corporateEventMovementOfKey(t.naturalKey) !== null)) {
    return 'uncaptured_corporate_event';
  }
  if (unclassified.length > 0) return 'unclassified_rows';
  return 'missing_history';
}
