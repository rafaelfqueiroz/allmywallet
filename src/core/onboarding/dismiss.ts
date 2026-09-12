import type { Clock } from '@/core/shared/clock';
import type { UserId } from '@/core/shared/ids';
import type { OnboardingDismissalPort } from '@/core/onboarding/ports';

/**
 * SPEC-020 BR-020-11..13 — dismiss and reopen the guide. CONTRACT STUB:
 * signatures are fixed; bodies are implemented by the backend dispatch.
 */
export async function dismissOnboarding(
  _port: OnboardingDismissalPort,
  _userId: UserId,
  _clock: Clock,
): Promise<void> {
  throw new Error('not implemented');
}

export async function reopenOnboarding(
  _port: OnboardingDismissalPort,
  _userId: UserId,
): Promise<void> {
  throw new Error('not implemented');
}
