import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { users } from '@/db/schema/users';
import type { Clock } from '@/core/shared/clock';
import type { UserId } from '@/core/shared/ids';
import type { OpportunityAlert, OpportunityNotifier } from '@/core/opportunity/ports';
import { hashUserId, logger } from '@/lib/logger';
import { signUnsubscribeToken } from '@/lib/unsubscribe-token';
import { renderOpportunityEmail } from '@/adapters/email/opportunity-email';
import { appOrigin } from '@/adapters/email/app-origin';

/**
 * SPEC-021 BR-021-34/DL-021-04 — real delivery, through Resend's HTTP API on
 * its free tier. The one class `LogEmailSender`'s own comment said swapping in
 * a provider would take: same `OpportunityNotifier` port, same rendered
 * `subject`/`text`/`html`, nothing in `core/` touched (BR-021-35 — consent,
 * cooldown, idempotency and content stay SPEC-018's, decided before a send is
 * ever requested).
 *
 * Plain `fetch` rather than the vendor SDK: one POST does not justify a
 * dependency in a public image (BR-021-14).
 *
 * **Throws on failure.** `handleOpportunityEvaluate` guards each send on its
 * own and logs a failed delivery — and the claim was already committed, so a
 * failure loses one message rather than duplicating it on the next poll
 * (DL-018-08). Swallowing the error here would hide that from the log.
 */
export interface ResendConfig {
  readonly apiKey: string;
  readonly from: string;
  readonly baseUrl?: string;
}

export class ResendEmailSender implements OpportunityNotifier {
  constructor(
    private readonly database: Database,
    private readonly clock: Clock,
    private readonly config: ResendConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendStateChange(userId: UserId, alert: OpportunityAlert): Promise<void> {
    // `users` is the tenant root, deliberately outside RLS (src/db/shared-tables.ts);
    // the address is read here, at delivery, and never logged (AR-49/BR-004-04).
    const [recipient] = await this.database
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    if (!recipient) {
      throw new Error('ResendEmailSender: the recipient account no longer exists');
    }

    const token = signUnsubscribeToken(userId, this.clock.now());
    const unsubscribeUrl = `${appOrigin()}/unsubscribe?token=${encodeURIComponent(token)}`;
    const rendered = renderOpportunityEmail(alert, unsubscribeUrl);

    const response = await this.fetchImpl(
      `${this.config.baseUrl ?? 'https://api.resend.com'}/emails`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [recipient.email],
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>` },
        }),
      },
    );

    if (!response.ok) {
      // The body can echo the recipient address back; only the status is kept.
      throw new Error(`ResendEmailSender: delivery rejected with HTTP ${response.status}`);
    }

    logger.info(
      { userIdHash: hashUserId(userId), state: alert.state },
      'SPEC-021 BR-021-34: opportunity state change delivered',
    );
  }
}
