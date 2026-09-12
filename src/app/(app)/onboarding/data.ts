import type { UserId } from '@/core/shared/ids';
import type { OnboardingStatus } from '@/core/onboarding/status';

/**
 * SPEC-020 — the onboarding loader and the dismissal writes, for the page and
 * its actions (AR-31). CONTRACT STUB: signatures are fixed; bodies are
 * implemented by the backend dispatch.
 */
export async function loadOnboardingStatus(_userId: UserId): Promise<OnboardingStatus> {
  throw new Error('not implemented');
}

export async function dismissOnboardingFor(_userId: UserId): Promise<void> {
  throw new Error('not implemented');
}

export async function reopenOnboardingFor(_userId: UserId): Promise<void> {
  throw new Error('not implemented');
}
