'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUserId } from '@/lib/session';
import { db } from '@/db/client';
import { resolveConfig } from '@/config/resolve';
import { isErr } from '@/core/shared/result';
import { CONSENT_PURPOSES, isConsentPurpose } from '@/core/privacy/ports';
import { grantConsent, revokeConsent } from '@/core/privacy/consent';
import { requestAccountDeletion } from '@/core/privacy/delete-account';
import { withPrivacyDeps, buildAccountDeletionDeps } from '@/app/(settings)/privacy/composition';
import { CURRENT_PRIVACY_POLICY_VERSION } from '@/app/privacy-policy/policy-version';

/**
 * AR-32: each action validates input with Zod at the boundary (DV-07),
 * resolves the session via `requireUserId()` (AR-12: never a client-supplied
 * id), and calls exactly one use case.
 */

const PurposeSchema = z.custom<(typeof CONSENT_PURPOSES)[number]>(
  (value): value is (typeof CONSENT_PURPOSES)[number] =>
    typeof value === 'string' && isConsentPurpose(value),
  'not a declared consent purpose',
);

export async function setConsentAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const parsedPurpose = PurposeSchema.safeParse(formData.get('purpose'));
  if (!parsedPurpose.success) return;

  // BR-004-06: granular and opt-in — the checkbox's own state decides grant
  // vs. revoke; there is no bundled "accept all" path.
  const granting = formData.get('granted') === 'on';

  const result = await withPrivacyDeps(userId, (deps) =>
    granting
      ? grantConsent(deps, userId, {
          purpose: parsedPurpose.data,
          policyVersion: CURRENT_PRIVACY_POLICY_VERSION,
        })
      : revokeConsent(deps, userId, parsedPurpose.data),
  );

  // A revoke on an already-revoked (or never-granted) purpose is reported as
  // CONSENT_NOT_GRANTED — not surfaced as an error here, since from the
  // user's perspective "I unchecked a box that was already unchecked" is not
  // a failure worth rendering one for.
  if (isErr(result) && result.error.code !== 'CONSENT_NOT_GRANTED') return;

  revalidatePath('/privacy');
}

/**
 * SPEC-004 BR-004-09 — self-service, irreversible. No confirmation-text
 * input beyond the form submission itself: the page's own submit button is
 * the confirmation step (mirroring `cancelBatchAction`'s pattern for another
 * irreversible action), rather than inventing a second, home-grown "type
 * DELETE to confirm" flow this issue's Modules table does not ask for.
 */
export async function requestAccountDeletionAction(): Promise<void> {
  const userId = await requireUserId();
  const deletionWindowDays = (
    await resolveConfig('retention.deletion_window_days', { db })
  ).value;

  const result = await requestAccountDeletion(buildAccountDeletionDeps(), userId, {
    deletionWindowDays,
  });
  if (isErr(result)) {
    revalidatePath('/privacy');
    return;
  }

  redirect('/privacy');
}
