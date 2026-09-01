import { type DomainError, domainError } from '@/core/shared/domain-error';

/**
 * SPEC-018 — AR-37/AR-38: a stable code plus structured context, never a
 * pre-formatted string. AR-39: context is primitives only — an id, a price as
 * a decimal string, an asset class — never anything that could carry personal
 * data.
 */
export const OpportunityErrorCode = {
  RULE_NOT_FOUND: 'RULE_NOT_FOUND',

  /** BR-018-01 — no rule may exist on an asset the user does not currently hold. */
  ASSET_NOT_HELD: 'ASSET_NOT_HELD',
  /** BR-018-02 — CDB, LCI and LCA have no market price and can never carry a rule. */
  ASSET_CLASS_NOT_WATCHABLE: 'ASSET_CLASS_NOT_WATCHABLE',
  /**
   * `OpportunityRuleRepository.findByAsset` returns at most one rule per
   * asset — the shape the spec's watch screen assumes (BR-018-20 shows "the"
   * state and "the" last email for an asset, not a list of them). A second
   * `createRule` on an asset that already has one is therefore refused rather
   * than silently producing a second rule the screen has no way to show.
   */
  RULE_ALREADY_EXISTS: 'RULE_ALREADY_EXISTS',

  /** BR-018-05 — at least one of the two bounds must be set. */
  NO_BOUNDS_SET: 'NO_BOUNDS_SET',
  /** BR-018-10 — a threshold is money and must be strictly positive. */
  INVALID_THRESHOLD: 'INVALID_THRESHOLD',
  /** BR-018-08 — enforced at write time, so overlap is impossible by construction. */
  LOWER_NOT_BELOW_UPPER: 'LOWER_NOT_BELOW_UPPER',
} as const;

export type OpportunityErrorCode = (typeof OpportunityErrorCode)[keyof typeof OpportunityErrorCode];

export function opportunityError(
  code: OpportunityErrorCode,
  context: Readonly<Record<string, string | number | boolean | null>> = {},
): DomainError<OpportunityErrorCode> {
  return domainError(code, context);
}
