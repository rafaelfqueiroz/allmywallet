import type { BusinessDate } from '@/core/shared/clock';
import { type DomainError, domainError } from '@/core/shared/domain-error';
import type { Quantity } from '@/core/shared/money';

/**
 * AR-37: a stable code plus structured context, never a formatted string.
 * AR-39: structural facts only — no asset name, no institution name, nothing
 * that identifies a person, because these travel into logs and Sentry.
 */
export const PositionErrorCode = {
  /**
   * SPEC-006 BR-006-15's headline case, and the reason #9 and #10 land
   * together: "selling more than the quantity held **at that date**" cannot be
   * answered without replaying the ledger up to that date.
   */
  INSUFFICIENT_QUANTITY: 'INSUFFICIENT_QUANTITY',
  /** SPEC-007 BR-007-04: a split or grupamento row with no ratio to apply. */
  MISSING_EVENT_RATIO: 'MISSING_EVENT_RATIO',
  /** A ratio of zero or less would erase or invert a position rather than rescale it. */
  INVALID_EVENT_RATIO: 'INVALID_EVENT_RATIO',
  /** SPEC-007 BR-007-05b: an incoming conversion must state the exact carried cost. */
  MISSING_CONVERSION_COST_BASIS: 'MISSING_CONVERSION_COST_BASIS',
  /**
   * SPEC-007 BR-007-05c: the replay was not told what kind of asset an
   * amortization belongs to, so it cannot say how much of it is principal.
   * A wiring defect rather than a ledger one — every writer of the position
   * cache supplies the terms — and failing closed is what keeps it from
   * becoming a plausible wrong *preço médio* instead.
   */
  AMORTIZATION_TERMS_UNKNOWN: 'AMORTIZATION_TERMS_UNKNOWN',
  /**
   * SPEC-007 BR-007-05c defines the principal of an amortization for a listed
   * asset and for an NTN-B1 title only. Any other asset — another Tesouro
   * title, bank paper — has no rule, so its amortization is refused rather
   * than given an invented principal.
   */
  AMORTIZATION_NOT_SUPPORTED: 'AMORTIZATION_NOT_SUPPORTED',
  /**
   * SPEC-007 BR-007-05c: an NTN-B1 payment dated outside its title's schedule
   * has no "payments remaining including this one" to divide by.
   */
  AMORTIZATION_OUTSIDE_SCHEDULE: 'AMORTIZATION_OUTSIDE_SCHEDULE',
} as const;

export type PositionErrorCode = (typeof PositionErrorCode)[keyof typeof PositionErrorCode];

/**
 * The context AR-37 names verbatim: `{ code, held, requested, date }`. The UI
 * turns it into BR-006-15's "explanation naming the held quantity" through the
 * pt-BR catalogue (AR-38), so the numbers must be in the context rather than
 * baked into a message here.
 */
export function insufficientQuantity(
  held: Quantity,
  requested: Quantity,
  date: BusinessDate,
): DomainError<typeof PositionErrorCode.INSUFFICIENT_QUANTITY> {
  return domainError(PositionErrorCode.INSUFFICIENT_QUANTITY, {
    held: held.toString(),
    requested: requested.toString(),
    date,
  });
}

export function missingEventRatio(
  date: BusinessDate,
): DomainError<typeof PositionErrorCode.MISSING_EVENT_RATIO> {
  return domainError(PositionErrorCode.MISSING_EVENT_RATIO, { date });
}

export function invalidEventRatio(
  ratio: Quantity,
  date: BusinessDate,
): DomainError<typeof PositionErrorCode.INVALID_EVENT_RATIO> {
  return domainError(PositionErrorCode.INVALID_EVENT_RATIO, { ratio: ratio.toString(), date });
}

export function missingConversionCostBasis(
  date: BusinessDate,
): DomainError<typeof PositionErrorCode.MISSING_CONVERSION_COST_BASIS> {
  return domainError(PositionErrorCode.MISSING_CONVERSION_COST_BASIS, { date });
}

export function amortizationTermsUnknown(
  date: BusinessDate,
): DomainError<typeof PositionErrorCode.AMORTIZATION_TERMS_UNKNOWN> {
  return domainError(PositionErrorCode.AMORTIZATION_TERMS_UNKNOWN, { date });
}

export function amortizationNotSupported(
  date: BusinessDate,
): DomainError<typeof PositionErrorCode.AMORTIZATION_NOT_SUPPORTED> {
  return domainError(PositionErrorCode.AMORTIZATION_NOT_SUPPORTED, { date });
}

export function amortizationOutsideSchedule(
  date: BusinessDate,
  firstPayment: BusinessDate,
  lastPayment: BusinessDate,
): DomainError<typeof PositionErrorCode.AMORTIZATION_OUTSIDE_SCHEDULE> {
  return domainError(PositionErrorCode.AMORTIZATION_OUTSIDE_SCHEDULE, {
    date,
    firstPayment,
    lastPayment,
  });
}
