import { hashUserId, logger } from '@/lib/logger';
import type { UserId } from '@/core/shared/ids';
import type { NotificationPort } from '@/core/privacy/ports';

/**
 * SPEC-004 BR-004-09's "confirmed by email" — the interim implementation.
 *
 * No email-sending adapter exists anywhere in this codebase yet: there is no
 * chosen subprocessor (SMTP relay, Postgres-friendly transactional-email
 * API), no credential in `src/lib/env.ts`, and no other feature that sends
 * mail either (SPEC-002's `import.reminder_enabled` toggles a feature that
 * doesn't exist yet, for the same reason). Building one is out of scope for
 * this issue — flagged in the #7 report rather than silently skipped.
 *
 * This adapter logs, at `info`, that a notification *would* have been sent —
 * `hashUserId` keeps the log line free of an email address (AR-49/BR-004-04)
 * — so the call sites, tests, and audit trail are all real today, and
 * swapping in a real provider later is exactly one new adapter implementing
 * `NotificationPort`, with no change to `core/privacy`.
 */
export class LogNotificationAdapter implements NotificationPort {
  async sendAccountDeletionRequested(userId: UserId, purgeAt: Date): Promise<void> {
    logger.info(
      { userIdHash: hashUserId(userId), purgeAt: purgeAt.toISOString() },
      'SPEC-004 BR-004-09: account deletion requested — confirmation email not sent (no email provider configured)',
    );
  }

  async sendAccountDeletionCompleted(userId: UserId): Promise<void> {
    logger.info(
      { userIdHash: hashUserId(userId) },
      'SPEC-004 BR-004-09: account deletion completed — confirmation email not sent (no email provider configured)',
    );
  }
}
