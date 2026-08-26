import { type DomainError, domainError } from '@/core/shared/domain-error';

/**
 * SPEC-010 — AR-37/AR-38: a stable code plus structured context, never a
 * pre-formatted string. AR-39: context is primitives only — an id, a
 * quantity string, never anything that could carry personal data.
 */
export const WalletErrorCode = {
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  /** BR-010-01: a wallet must have a non-empty name. */
  INVALID_NAME: 'INVALID_NAME',
  /** A zero or negative allocation/sale/purchase quantity. */
  INVALID_ALLOCATION_QUANTITY: 'INVALID_ALLOCATION_QUANTITY',
  /** BR-010-05: the sum invariant, refused at write time. */
  ALLOCATION_EXCEEDS_HOLDINGS: 'ALLOCATION_EXCEEDS_HOLDINGS',
  /** BR-010-17: a wallet-specified sale exceeding that wallet's own allocation. */
  WALLET_ALLOCATION_INSUFFICIENT: 'WALLET_ALLOCATION_INSUFFICIENT',
  /** BR-010-18: a corporate-event ratio that is zero or negative. */
  INVALID_RATIO: 'INVALID_RATIO',

  // -------------------------------------------------------------------------
  // SPEC-017 — wallet balancing.
  // -------------------------------------------------------------------------

  /** BR-017-04 / AC-4: a manual set that does not total exactly 100 %. Context carries the signed `difference`. */
  TARGETS_MUST_TOTAL_100: 'TARGETS_MUST_TOTAL_100',
  /** A target percentage outside 0–100. */
  INVALID_TARGET_PCT: 'INVALID_TARGET_PCT',
  /** The same asset named twice in one target set. */
  DUPLICATE_TARGET_ASSET: 'DUPLICATE_TARGET_ASSET',
  /** BR-017-09/12: a target naming fixed income, or an asset this wallet does not hold. */
  TARGET_ASSET_NOT_TARGETABLE: 'TARGET_ASSET_NOT_TARGETABLE',
  /** A targetable holding left out of the set, which would leave it outside its own denominator. */
  TARGET_ASSET_MISSING: 'TARGET_ASSET_MISSING',
  /** BR-017-11: a wallet holding only fixed income cannot define targets. */
  WALLET_HAS_NO_TARGETABLE_ASSETS: 'WALLET_HAS_NO_TARGETABLE_ASSETS',
  /** BR-017-08 / AC-5: leaving manual mode would discard hand-set targets and was not confirmed. */
  TARGET_DISCARD_NOT_CONFIRMED: 'TARGET_DISCARD_NOT_CONFIRMED',
} as const;

export type WalletErrorCode = (typeof WalletErrorCode)[keyof typeof WalletErrorCode];

export function walletError(
  code: WalletErrorCode,
  context: Readonly<Record<string, string | number | boolean | null>> = {},
): DomainError<WalletErrorCode> {
  return domainError(code, context);
}
