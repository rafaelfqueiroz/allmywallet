import { type DomainError, domainError } from '@/core/shared/domain-error';

/**
 * SPEC-006 BR-006-15: validation prevents impossible states, "with an
 * explanation of why, not a silent rejection".
 *
 * AR-37: the explanation is assembled from a stable code plus structured
 * context by the i18n layer (AR-38), never formatted here. AR-39: context
 * carries structural facts only — an asset *id*, never an asset name, and
 * nothing that identifies a person, because these strings reach logs and
 * Sentry.
 */
export const LedgerErrorCode = {
  TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND',
  /** A quantity of zero (or the wrong sign) for a type that cannot have one. */
  INVALID_QUANTITY: 'INVALID_QUANTITY',
  /** A price below zero. Fees and prices are magnitudes; direction is the type's job. */
  NEGATIVE_UNIT_PRICE: 'NEGATIVE_UNIT_PRICE',
  NEGATIVE_FEES: 'NEGATIVE_FEES',
  /** SPEC-007 BR-007-04: a split or grupamento with no ratio to apply. */
  RATIO_REQUIRED: 'RATIO_REQUIRED',
  /** A ratio on a type that has no ratio semantics — a buy, say. */
  RATIO_NOT_APPLICABLE: 'RATIO_NOT_APPLICABLE',
  INVALID_RATIO: 'INVALID_RATIO',
  /** A trade that has not happened yet is not a ledger entry. */
  FUTURE_TRADE_DATE: 'FUTURE_TRADE_DATE',
  /** BR-006-17: a bulk operation naming nothing has no meaning. */
  EMPTY_SELECTION: 'EMPTY_SELECTION',
  /** BR-006-07: a page size outside the supported range. */
  INVALID_PAGINATION: 'INVALID_PAGINATION',
} as const;

export type LedgerErrorCode = (typeof LedgerErrorCode)[keyof typeof LedgerErrorCode];

export function ledgerError(
  code: LedgerErrorCode,
  context: Readonly<Record<string, string | number | boolean | null>> = {},
): DomainError<LedgerErrorCode> {
  return domainError(code, context);
}
