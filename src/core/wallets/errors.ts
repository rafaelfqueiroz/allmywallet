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
} as const;

export type WalletErrorCode = (typeof WalletErrorCode)[keyof typeof WalletErrorCode];

export function walletError(
  code: WalletErrorCode,
  context: Readonly<Record<string, string | number | boolean | null>> = {},
): DomainError<WalletErrorCode> {
  return domainError(code, context);
}
