import { FakeClock } from '@/core/shared/clock';
import { FakeConsentRepository } from '@/core/privacy/test-support/fake-repositories';
import type { GoalDependencies } from '@/core/goals/dependencies';
import {
  FakeGoalNotificationPort,
  FakeWalletGoalRepository,
  FakeWalletValuationPort,
} from '@/core/goals/test-support/fake-repositories';

/** Test-only bundle of every fake, for the common case of not caring which one a test exercises. */
export interface FakeGoalDependencies extends GoalDependencies {
  readonly goals: FakeWalletGoalRepository;
  readonly valuation: FakeWalletValuationPort;
  readonly notifications: FakeGoalNotificationPort;
  readonly consents: FakeConsentRepository;
  readonly clock: FakeClock;
}

export function buildFakeGoalDeps(
  now: Date | string = '2026-03-15T12:00:00Z',
): FakeGoalDependencies {
  return {
    goals: new FakeWalletGoalRepository(),
    valuation: new FakeWalletValuationPort(),
    notifications: new FakeGoalNotificationPort(),
    consents: new FakeConsentRepository(),
    clock: new FakeClock(now),
  };
}
