import { SystemClock } from '@/core/shared/clock';
import type { UserId } from '@/core/shared/ids';
import { dismissOnboarding, reopenOnboarding } from '@/core/onboarding/dismiss';
import { deriveOnboardingStatus, type OnboardingStatus } from '@/core/onboarding/status';
import {
  DrizzleOnboardingDismissalRepository,
  DrizzleOnboardingFactsRepository,
} from '@/adapters/db/onboarding-repository';
import { db } from '@/db/client';
import { withTenant } from '@/db/tenant';

/**
 * SPEC-020 — the onboarding loader and the dismissal writes, for the page and
 * its actions (AR-31).
 *
 * AR-11: `OnboardingFacts` is read inside **one** `withTenant` transaction —
 * `DrizzleOnboardingFactsRepository.readFacts` runs its five queries on that
 * single `Tx`. `users.onboarding_dismissed_at` is read separately, through
 * `DrizzleUserRepository`'s sibling adapter, because `users` is the tenant
 * root and is deliberately not RLS-scoped (BR-020-09's comment on the
 * column): there is no tenant transaction for that read to join, and forcing
 * one would buy nothing.
 */
export async function loadOnboardingStatus(userId: UserId): Promise<OnboardingStatus> {
  const dismissal = new DrizzleOnboardingDismissalRepository(db);
  const [facts, dismissedAt] = await Promise.all([
    withTenant(userId, async (tx) => new DrizzleOnboardingFactsRepository(tx).readFacts(), db),
    dismissal.dismissedAt(userId),
  ]);
  return deriveOnboardingStatus(facts, dismissedAt);
}

export async function dismissOnboardingFor(userId: UserId): Promise<void> {
  const dismissal = new DrizzleOnboardingDismissalRepository(db);
  await dismissOnboarding(dismissal, userId, new SystemClock());
}

export async function reopenOnboardingFor(userId: UserId): Promise<void> {
  const dismissal = new DrizzleOnboardingDismissalRepository(db);
  await reopenOnboarding(dismissal, userId);
}
