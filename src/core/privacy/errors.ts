import { type DomainError, domainError } from '@/core/shared/domain-error';

/**
 * SPEC-004 — AR-37/AR-38: a stable code plus structured context, never a
 * pre-formatted string. AR-39: context is primitives only.
 */
export const PrivacyErrorCode = {
  /** BR-004-06: only a purpose in `CONSENT_PURPOSES` can be decided on. */
  INVALID_CONSENT_PURPOSE: 'INVALID_CONSENT_PURPOSE',
  /** Revoking a purpose that was never granted (or already revoked). */
  CONSENT_NOT_GRANTED: 'CONSENT_NOT_GRANTED',
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  /** BR-004-09: deletion is requested once; a second request is a no-op read, not an error the UI needs to render twice. */
  DELETION_ALREADY_REQUESTED: 'DELETION_ALREADY_REQUESTED',
  /** The scheduled purge fired before `retention.deletion_window_days` elapsed — a defect if it ever happens, not a user-facing outcome. */
  DELETION_WINDOW_NOT_ELAPSED: 'DELETION_WINDOW_NOT_ELAPSED',
} as const;

export type PrivacyErrorCode = (typeof PrivacyErrorCode)[keyof typeof PrivacyErrorCode];

export function privacyError(
  code: PrivacyErrorCode,
  context: Readonly<Record<string, string | number | boolean | null>> = {},
): DomainError<PrivacyErrorCode> {
  return domainError(code, context);
}
