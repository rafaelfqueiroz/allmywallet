'use server';

import { redirect } from 'next/navigation';
import { verifyUnsubscribeToken } from '@/lib/unsubscribe-token';
import { revokeConsent } from '@/core/privacy/consent';
import { withPrivacyDeps } from '@/app/(settings)/privacy/composition';

/**
 * SPEC-018 BR-018-26 — the one write in this product whose `userId` does not
 * come from `requireUserId()` (AR-12). That rule exists so a request can
 * never claim to act as someone else; the deliberate, documented exception
 * here is that a *signed capability token* — `verifyUnsubscribeToken`
 * (`src/lib/unsubscribe-token.ts`) — plays the same role a verified session
 * would, for exactly one act: revoking `email_reminders` for the one account
 * the token names. The alternative is a sign-in wall in front of an
 * unsubscribe link, which BR-018-26 explicitly rules out ("honoured without
 * requiring sign-in") — a person reading a marketing/opportunity email is, by
 * definition, not already signed in on that device.
 *
 * **Why this is a server action and not read on the page's GET.** A mail
 * client (or a link-preview crawler) can and does prefetch a GET request
 * behind a link with no user intent behind it. If verifying the token were
 * enough to revoke consent, that prefetch would silently unsubscribe someone
 * who never clicked anything. Revocation only happens here, behind a POST a
 * human triggers by submitting the form on `/unsubscribe` — the page itself
 * only ever reads the token to decide what to show (`page.tsx`).
 */
export async function confirmUnsubscribeAction(formData: FormData): Promise<void> {
  const token = formData.get('token');
  const userId = typeof token === 'string' ? verifyUnsubscribeToken(token) : null;

  if (userId === null) {
    // Same generic destination as an invalid token on the GET — telling an
    // anonymous visitor *why* a token failed helps nobody but an attacker
    // probing the format (see `verifyUnsubscribeToken`'s own doc comment).
    redirect('/unsubscribe');
  }

  // BR-018-26 — `email_reminders` is the exact purpose BR-018-25 gates every
  // opportunity send on (`evaluateOpportunities`'s `consented` check), so
  // revoking it here *is* the global unsubscribe: every future opportunity
  // email for this account is refused at that check, whichever asset's rule
  // fires next.
  const result = await withPrivacyDeps(userId, (deps) =>
    revokeConsent(deps, userId, 'email_reminders'),
  );

  // `revokeConsent` returns `CONSENT_NOT_GRANTED` when the purpose was never
  // granted, or was already revoked. From this visitor's point of view that
  // is not a failure to report — they asked for no more email, and there
  // already is none. Any other outcome still lands on the same "done" state:
  // this endpoint promises the visitor no email, not a diagnostic.
  void result;

  redirect('/unsubscribe?done=1');
}
