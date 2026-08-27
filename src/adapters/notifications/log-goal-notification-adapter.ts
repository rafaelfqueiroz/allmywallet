import type { BusinessDate } from '@/core/shared/clock';
import { hashUserId, logger } from '@/lib/logger';
import type { UserId, WalletGoalId } from '@/core/shared/ids';
import type { GoalNotificationPort } from '@/core/goals/ports';

/**
 * SPEC-019 BR-019-25 — the interim implementation, in the exact shape of
 * `LogNotificationAdapter` (`src/adapters/notifications/log-notification-adapter.ts`),
 * for the same reason: no email-sending adapter exists anywhere in this
 * codebase yet — no chosen subprocessor, no credential in `src/lib/env.ts` —
 * so building a real one is out of scope here and flagged rather than
 * silently skipped.
 *
 * BR-019-25 itself points at SPEC-018 BR-018-25..27 for the consent and
 * unsubscribe model a real send would need, and **SPEC-018 (Buy/Sell
 * Opportunity) is not built.** What gates this send *today* is not that
 * model — it is SPEC-004's own `email_reminders` purpose, checked by
 * `core/goals/achievement.ts#notifyIfConsented` before this port is ever
 * called. A user who has not opted in never reaches this adapter at all.
 *
 * This adapter logs, at `info`, that a notification *would* have been sent —
 * `hashUserId` keeps the log line free of an email address (AR-49/BR-004-04)
 * — so the call sites, the tests and the audit trail are all real today, and
 * swapping in a real provider later is exactly one new adapter implementing
 * `GoalNotificationPort`, with no change to `core/goals`.
 */
export class LogGoalNotificationAdapter implements GoalNotificationPort {
  async sendGoalAchieved(
    userId: UserId,
    goalId: WalletGoalId,
    achievedOn: BusinessDate,
  ): Promise<void> {
    logger.info(
      {
        userIdHash: hashUserId(userId),
        goalId,
        achievedOn: achievedOn,
      },
      'SPEC-019 BR-019-25: wallet goal achieved — confirmation email not sent (no email provider configured)',
    );
  }
}
