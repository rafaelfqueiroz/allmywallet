import type { Clock } from '@/core/shared/clock';
import type { UserId } from '@/core/shared/ids';
import type { OpportunityAlert, OpportunityNotifier } from '@/core/opportunity/ports';
import { hashUserId, logger } from '@/lib/logger';
import { env } from '@/lib/env';
import { signUnsubscribeToken } from '@/lib/unsubscribe-token';
import { renderOpportunityEmail } from '@/adapters/email/opportunity-email';

/**
 * SPEC-018 BR-018-25/DL-018-07 — the interim implementation, in the exact
 * shape of `LogNotificationAdapter`/`LogGoalNotificationAdapter`
 * (`src/adapters/notifications/`), for the same reason: no email-sending
 * adapter exists anywhere in this codebase yet — no chosen subprocessor
 * (SMTP relay, transactional-email API), no credential in `src/lib/env.ts`,
 * and choosing one is a legal/product decision this task is not authorised to
 * make (it needs an LGPD subprocessor-inventory entry, BR-004-18, in the
 * published privacy policy — `src/app/privacy-policy/page.tsx`).
 *
 * **What is real here and what is not.** The render path is real: every
 * message this class would send is fully composed by `renderOpportunityEmail`
 * — subject, plain text and HTML, in pt-BR, carrying the unsubscribe link —
 * so the copy, the i18n catalogue and every test in
 * `tests/integration/opportunity-email.test.ts` exercise the exact bytes a
 * real send would transmit. Only the transport is missing: this class logs,
 * at `info`, that a rendered message *would* have been sent — `hashUserId`
 * and no address (AR-49/BR-004-04) — rather than calling out to a provider
 * that does not exist yet. Swapping in a real provider later is exactly one
 * new class implementing `OpportunityNotifier`
 * (`core/opportunity/ports.ts`) that calls a real transport with this same
 * rendered `subject`/`text`/`html`, with no change anywhere in `core/`.
 */
export class LogEmailSender implements OpportunityNotifier {
  constructor(private readonly clock: Clock) {}

  async sendStateChange(userId: UserId, alert: OpportunityAlert): Promise<void> {
    const token = signUnsubscribeToken(userId, this.clock.now());
    const unsubscribeUrl = `${appOrigin()}/unsubscribe?token=${encodeURIComponent(token)}`;
    const rendered = renderOpportunityEmail(alert, unsubscribeUrl);

    /*
     * AR-49/BR-004-04 — deliberately **not** the asset code, and not the
     * subject line either, which contains it. A hashed user id is
     * pseudonymous on its own; a hashed user id beside a ticker is a record
     * that this person holds that ticker, sitting in a log stream that is
     * neither RLS-scoped nor covered by SPEC-004's export and deletion
     * rights. `LogGoalNotificationAdapter` logs an opaque id for the same
     * reason. The state alone says nothing about who holds what.
     *
     * `subjectLength`/`bodyLength` are here so a rendering failure — an empty
     * body, an unsubstituted placeholder — is still visible in the log
     * without the content itself being in it.
     */
    logger.info(
      {
        userIdHash: hashUserId(userId),
        state: alert.state,
        subjectLength: rendered.subject.length,
        bodyLength: rendered.text.length,
      },
      'SPEC-018 BR-018-25/DL-018-07: opportunity state change — email rendered, not sent (no email provider configured)',
    );
  }
}

/**
 * `AUTH_URL` (SPEC-001 #42) is `https://host/api/auth` — `URL.origin` strips
 * the path, which is exactly the canonical public origin a link in an email
 * needs. Falls back to a local default outside production, where `AUTH_URL`
 * is legitimately unset (`src/lib/trusted-host.ts`).
 */
function appOrigin(): string {
  const authUrl = env().AUTH_URL;
  if (authUrl !== undefined) {
    try {
      return new URL(authUrl).origin;
    } catch {
      // Falls through to the local default below — an unparsable AUTH_URL is
      // already a startup-time failure elsewhere (`assertTrustedHostConfigured`);
      // this function only ever renders a link, it does not gate a deploy.
    }
  }
  return 'http://localhost:3000';
}
