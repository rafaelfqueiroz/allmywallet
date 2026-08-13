import { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import { type Result, err, ok } from '@/core/shared/result';
import type { Money, Quantity } from '@/core/shared/money';
import { LedgerErrorCode, ledgerError } from '@/core/ledger/errors';
import { requiresRatio, type TransactionType } from '@/core/ledger/transaction';

/**
 * SPEC-006 BR-006-15 — the guards that do **not** need the ledger.
 *
 * The rule BR-006-15 leads with — "selling more than the quantity held at that
 * date" — is deliberately not here: answering it requires replaying the ledger
 * up to that date, so it lives in the use cases, which have a repository.
 * Everything in this file is decidable from the row alone and is therefore a
 * pure function, testable with no database (AR-01, TS-01).
 */

export interface TransactionDraft {
  readonly type: TransactionType;
  readonly tradeDate: BusinessDate;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly fees: Money;
  readonly ratio: Quantity | null;
}

/**
 * Types whose quantity must be strictly positive. Direction is carried by the
 * *type* — a sell of 100 is `quantity: 100`, never `-100` — so a signed
 * quantity here would mean two different encodings of the same trade and two
 * different answers from the engine.
 */
const POSITIVE_QUANTITY_TYPES: ReadonlySet<TransactionType> = new Set<TransactionType>([
  'buy',
  'sell',
  'subscription',
  'transfer_in',
  'transfer_out',
  'bonificacao',
]);

export function validateTransactionDraft(
  draft: TransactionDraft,
  today: BusinessDate,
): Result<void, DomainError> {
  // AR-29 / determinism: "today" arrives as an argument from the `Clock` port,
  // never from `Date.now()`, so the same draft validates the same way in a
  // test, in São Paulo and on a CI runner set to UTC.
  if (BusinessDate.isAfter(draft.tradeDate, today)) {
    return err(
      ledgerError(LedgerErrorCode.FUTURE_TRADE_DATE, { tradeDate: draft.tradeDate, today }),
    );
  }

  const quantityError = validateQuantity(draft);
  if (quantityError !== null) return err(quantityError);

  if (draft.unitPrice.isNegative()) {
    return err(
      ledgerError(LedgerErrorCode.NEGATIVE_UNIT_PRICE, { unitPrice: draft.unitPrice.toString() }),
    );
  }

  if (draft.fees.isNegative()) {
    return err(ledgerError(LedgerErrorCode.NEGATIVE_FEES, { fees: draft.fees.toString() }));
  }

  return validateRatio(draft);
}

function validateQuantity(draft: TransactionDraft): DomainError | null {
  /**
   * SPEC-005 inserts an `adjustment` when a B3 *Posição* extract disagrees
   * with the replayed ledger, and the disagreement runs both ways — so this is
   * the one type whose quantity is signed. A zero adjustment says nothing and
   * is refused rather than stored as a no-op nobody can interpret later.
   */
  if (draft.type === 'adjustment') {
    return draft.quantity.isZero()
      ? ledgerError(LedgerErrorCode.INVALID_QUANTITY, {
          type: draft.type,
          quantity: draft.quantity.toString(),
          reason: 'zero',
        })
      : null;
  }

  if (POSITIVE_QUANTITY_TYPES.has(draft.type) && !draft.quantity.isPositive()) {
    return ledgerError(LedgerErrorCode.INVALID_QUANTITY, {
      type: draft.type,
      quantity: draft.quantity.toString(),
      reason: 'not_positive',
    });
  }

  /**
   * What is left is proventos and the ratio events. Their quantity is
   * informational — the number of shares a dividend was paid on, or the share
   * count a split row happens to restate — so zero is legitimate, but a
   * negative one is not a thing that exists.
   */
  if (draft.quantity.isNegative()) {
    return ledgerError(LedgerErrorCode.INVALID_QUANTITY, {
      type: draft.type,
      quantity: draft.quantity.toString(),
      reason: 'negative',
    });
  }

  return null;
}

function validateRatio(draft: TransactionDraft): Result<void, DomainError> {
  // SPEC-007 BR-007-04: the ratio *is* the event for a split or grupamento.
  // A row without one cannot be replayed, and BR-007-15 warns exactly what
  // happens when a share-base event goes missing: every subsequent average is
  // wrong, quietly.
  if (requiresRatio(draft.type)) {
    if (draft.ratio === null) {
      return err(ledgerError(LedgerErrorCode.RATIO_REQUIRED, { type: draft.type }));
    }
    if (!draft.ratio.isPositive()) {
      return err(
        ledgerError(LedgerErrorCode.INVALID_RATIO, {
          type: draft.type,
          ratio: draft.ratio.toString(),
        }),
      );
    }
    return ok(undefined);
  }

  // A ratio anywhere else is a row that has been mis-typed. Storing it would
  // leave a field the engine ignores, which is how a "buy" that was meant to
  // be a split becomes invisible.
  if (draft.ratio !== null) {
    return err(
      ledgerError(LedgerErrorCode.RATIO_NOT_APPLICABLE, {
        type: draft.type,
        ratio: draft.ratio.toString(),
      }),
    );
  }

  return ok(undefined);
}
