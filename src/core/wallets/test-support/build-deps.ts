import { FakeClock } from '@/core/shared/clock';
import { FakeAssetCatalog } from '@/core/quotes/test-support';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import {
  FakePositionQueryPort,
  FakeWalletAllocationRepository,
  FakeWalletAssetRuleRepository,
  FakeWalletRepository,
  FakeWalletTargetRepository,
} from '@/core/wallets/test-support/fake-repositories';

/** Test-only bundle of every fake, for the common case of not caring which one a test exercises. */
export interface FakeWalletDependencies extends WalletDependencies {
  readonly wallets: FakeWalletRepository;
  readonly allocations: FakeWalletAllocationRepository;
  readonly assetRules: FakeWalletAssetRuleRepository;
  readonly targets: FakeWalletTargetRepository;
  readonly positionQuery: FakePositionQueryPort;
  readonly assetCatalog: FakeAssetCatalog;
  readonly clock: FakeClock;
}

export function buildFakeDeps(now: Date | string = '2026-03-15T12:00:00Z'): FakeWalletDependencies {
  return {
    wallets: new FakeWalletRepository(),
    allocations: new FakeWalletAllocationRepository(),
    assetRules: new FakeWalletAssetRuleRepository(),
    targets: new FakeWalletTargetRepository(),
    positionQuery: new FakePositionQueryPort(),
    assetCatalog: new FakeAssetCatalog(),
    clock: new FakeClock(now),
  };
}
