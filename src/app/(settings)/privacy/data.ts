import type { UserId } from '@/core/shared/ids';
import { listConsents, type ConsentState } from '@/core/privacy/consent';
import { getAccountDeletionStatus } from '@/core/privacy/delete-account';
import type { AccountDeletionStatus } from '@/core/privacy/ports';
import { withPrivacyDeps, buildAccountDeletionDeps } from '@/app/(settings)/privacy/composition';

/** AR-31: a Server Component reads through `core/` directly, never `db` from the component itself. */
export async function loadConsentStates(userId: UserId): Promise<readonly ConsentState[]> {
  return withPrivacyDeps(userId, (deps) => listConsents(deps, userId));
}

export async function loadDeletionStatus(userId: UserId): Promise<AccountDeletionStatus | null> {
  return getAccountDeletionStatus(buildAccountDeletionDeps(), userId);
}
