import type { Clock } from '@/core/shared/clock';
import type { UserId } from '@/core/shared/ids';
import type { OnboardingDismissalPort } from '@/core/onboarding/ports';

/**
 * SPEC-020 BR-020-11..13 — dismiss and reopen the guide. CONTRACT STUB:
 * signatures are fixed; bodies are implemented by the backend dispatch.
 */
export async function dismissOnboarding(
  port: OnboardingDismissalPort,
  userId: UserId,
  clock: Clock,
): Promise<void> {
  // SPEC-020 BR-020-09/11: the guide is dismissible at any step; the instant
  // is `clock.now()` rather than a boolean flag, matching the column's shape
  // (`users.onboarding_dismissed_at`, nullable) — a timestamp doubles as the
  // "is it dismissed" bit (BR-020-12: `dismissedAt !== null`) while also
  // being the value a future "dismissed since" surface could read.
  await port.setDismissedAt(userId, clock.now());
}

export async function reopenOnboarding(
  port: OnboardingDismissalPort,
  userId: UserId,
): Promise<void> {
  // SPEC-020 BR-020-13: reopening clears the dismissal — the guide's
  // `shouldGuide` is re-derived from `dismissedAt === null` and needs no
  // other write.
  await port.setDismissedAt(userId, null);
}
