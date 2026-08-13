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
