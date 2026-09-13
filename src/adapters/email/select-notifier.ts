import type { Database } from '@/db/client';
import type { Clock } from '@/core/shared/clock';
import type { OpportunityNotifier } from '@/core/opportunity/ports';
import { resolveConfig } from '@/config/resolve';
import { env } from '@/lib/env';
import { LogEmailSender } from '@/adapters/email/log-email-sender';
import { ResendEmailSender } from '@/adapters/email/resend-email-sender';

/**
 * SPEC-021 BR-021-34: the transport is selected by configuration
 * (`notifications.email_provider`), never by which deployment this happens to
 * be. `log` stays the default, so development and CI never send mail.
 *
 * Selecting `resend` without its credentials fails loudly instead of quietly
 * falling back to the log sender — a fallback would be exactly the silent
 * "the alert was never delivered" SPEC-018 exists to prevent.
 */
export async function buildOpportunityNotifier(
  database: Database,
  clock: Clock,
): Promise<OpportunityNotifier> {
  const provider = (await resolveConfig('notifications.email_provider', { db: database })).value;
  if (provider === 'log') return new LogEmailSender(clock);

  const { RESEND_API_KEY, EMAIL_FROM } = env();
  if (!RESEND_API_KEY || !EMAIL_FROM) {
    throw new Error(
      'notifications.email_provider is "resend" but RESEND_API_KEY or EMAIL_FROM is not set (SPEC-021 BR-021-34)',
    );
  }
  return new ResendEmailSender(database, clock, { apiKey: RESEND_API_KEY, from: EMAIL_FROM });
}
