import type { Clock } from '@/core/shared/clock';
import type { AssetCatalogPort } from '@/core/quotes/ports';
import type {
  PositionQueryPort,
  WalletAllocationRepository,
  WalletAssetRuleRepository,
  WalletRepository,
  WalletTargetRepository,
} from '@/core/wallets/ports';

/** What every wallets use case needs, injected at the composition root (AR-02). */
export interface WalletDependencies {
  readonly wallets: WalletRepository;
  readonly allocations: WalletAllocationRepository;
  readonly assetRules: WalletAssetRuleRepository;
  /** SPEC-017 — the wallet's own target set (BR-017-01..08). */
  readonly targets: WalletTargetRepository;
  readonly positionQuery: PositionQueryPort;
  /**
   * SPEC-017 BR-017-09 needs an asset's **class**, which `PositionQueryPort`
   * does not carry — it answers "how much is held", not "of what". SPEC-008's
   * catalog port already answers exactly that over the shared `assets` table
   * (AR-15), so it is reused rather than duplicated as a wallets-only port.
   */
  readonly assetCatalog: AssetCatalogPort;
  readonly clock: Clock;
}
