import { FakeClock } from '@/core/shared/clock';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import {
  FakePositionQueryPort,
  FakeWalletAllocationRepository,
  FakeWalletAssetRuleRepository,
  FakeWalletRepository,
} from '@/core/wallets/test-support/fake-repositories';

/** Test-only bundle of every fake, for the common case of not caring which one a test exercises. */
export interface FakeWalletDependencies extends WalletDependencies {
  readonly wallets: FakeWalletRepository;
  readonly allocations: FakeWalletAllocationRepository;
  readonly assetRules: FakeWalletAssetRuleRepository;
  readonly positionQuery: FakePositionQueryPort;
  readonly clock: FakeClock;
}

export function buildFakeDeps(now: Date | string = '2026-03-15T12:00:00Z'): FakeWalletDependencies {
  return {
    wallets: new FakeWalletRepository(),
    allocations: new FakeWalletAllocationRepository(),
    assetRules: new FakeWalletAssetRuleRepository(),
    positionQuery: new FakePositionQueryPort(),
    clock: new FakeClock(now),
  };
}
