import type { Clock } from '@/core/shared/clock';
import type {
  PositionQueryPort,
  WalletAllocationRepository,
  WalletAssetRuleRepository,
  WalletRepository,
} from '@/core/wallets/ports';

/** What every wallets use case needs, injected at the composition root (AR-02). */
export interface WalletDependencies {
  readonly wallets: WalletRepository;
  readonly allocations: WalletAllocationRepository;
  readonly assetRules: WalletAssetRuleRepository;
  readonly positionQuery: PositionQueryPort;
  readonly clock: Clock;
}
