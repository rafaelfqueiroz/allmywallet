import { type DomainError, domainError } from '@/core/shared/domain-error';

/**
 * SPEC-019 — AR-37/AR-38: a stable code plus structured context, never a
 * pre-formatted string. AR-39: context is primitives only — an id, a kind,
 * an amount as a decimal string — never anything that could carry personal
 * data. A goal's *name* is user-written text and is deliberately absent from
 * every context below for that reason.
 */
export const GoalErrorCode = {
  GOAL_NOT_FOUND: 'GOAL_NOT_FOUND',
  /** A goal must have a non-empty name, like a wallet (SPEC-010 BR-010-01). */
  INVALID_NAME: 'INVALID_NAME',
  /** BR-019-07: the amount is money and must be strictly positive. */
  INVALID_AMOUNT: 'INVALID_AMOUNT',

  /**
   * BR-019-03: the kind is fixed at creation.
   *
   * Refused rather than ignored. A caller that sends `kind: 'earnings'` for a
   * growth goal believes it is changing something; silently keeping the old
   * kind would leave it convinced the change landed, and the next chart it
   * renders would be the one it thought it had just replaced.
   */
  GOAL_KIND_IMMUTABLE: 'GOAL_KIND_IMMUTABLE',
  /** BR-019-05 with BR-019-03: the basis is part of what the kind fixes. */
  GOAL_BASIS_IMMUTABLE: 'GOAL_BASIS_IMMUTABLE',
  /** BR-019-06 with BR-019-03: likewise the period. */
  GOAL_PERIOD_IMMUTABLE: 'GOAL_PERIOD_IMMUTABLE',

  /** BR-019-05: a growth goal states which basis it measures. */
  GROWTH_GOAL_REQUIRES_BASIS: 'GROWTH_GOAL_REQUIRES_BASIS',
  /** BR-019-06: an earnings goal states which period it names. */
  EARNINGS_GOAL_REQUIRES_PERIOD: 'EARNINGS_GOAL_REQUIRES_PERIOD',
  /** A basis on an earnings goal — the field belongs to the other kind. */
  GOAL_BASIS_NOT_APPLICABLE: 'GOAL_BASIS_NOT_APPLICABLE',
  /** A period on a growth goal — likewise. */
  GOAL_PERIOD_NOT_APPLICABLE: 'GOAL_PERIOD_NOT_APPLICABLE',

  /**
   * The progress function was handed a goal of the other kind. Not a user
   * error — a wiring error — but returned rather than thrown because the two
   * progress functions are the seam a route hands a goal it read by id, and
   * a thrown fault there would take out the whole page instead of one card.
   */
  NOT_A_GROWTH_GOAL: 'NOT_A_GROWTH_GOAL',
  NOT_AN_EARNINGS_GOAL: 'NOT_AN_EARNINGS_GOAL',
} as const;

export type GoalErrorCode = (typeof GoalErrorCode)[keyof typeof GoalErrorCode];

export function goalError(
  code: GoalErrorCode,
  context: Readonly<Record<string, string | number | boolean | null>> = {},
): DomainError<GoalErrorCode> {
  return domainError(code, context);
}
