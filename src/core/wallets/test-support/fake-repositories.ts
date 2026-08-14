import type { AssetId, WalletId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type {
  AssetPositionQuery,
  PositionQueryPort,
  WalletAllocation,
  WalletAllocationRepository,
  WalletAssetRuleRepository,
  WalletRepository,
} from '@/core/wallets/ports';
import type { Wallet } from '@/core/wallets/wallet';

/**
 * TS-02: hand-written fakes implementing the real port interfaces — no
 * mocking library. TS-01: they let every wallets use-case test run with no
 * database; the SQL these stand in for is proven for real in
 * `tests/integration/` and `tests/isolation/`.
 */

export class FakeWalletRepository implements WalletRepository {
  #rows = new Map<WalletId, Wallet>();

  async findById(id: WalletId): Promise<Wallet | null> {
    return this.#rows.get(id) ?? null;
  }

  async list(): Promise<readonly Wallet[]> {
    return [...this.#rows.values()];
  }

  async insert(wallet: Wallet): Promise<void> {
    this.#rows.set(wallet.id, wallet);
  }

  async update(wallet: Wallet): Promise<void> {
    this.#rows.set(wallet.id, wallet);
  }

  async delete(id: WalletId): Promise<void> {
    this.#rows.delete(id);
  }
}

function key(walletId: WalletId, assetId: AssetId): string {
  return `${walletId}|${assetId}`;
}

export class FakeWalletAllocationRepository implements WalletAllocationRepository {
  #rows = new Map<string, WalletAllocation>();

  /** Counts locked reads, so a test can prove the sum invariant is checked under lock. */
  lockCount = 0;

  async listForAsset(assetId: AssetId): Promise<readonly WalletAllocation[]> {
    return [...this.#rows.values()].filter((row) => row.assetId === assetId);
  }

  async listForWallet(walletId: WalletId): Promise<readonly WalletAllocation[]> {
    return [...this.#rows.values()].filter((row) => row.walletId === walletId);
  }

  async listAll(): Promise<readonly WalletAllocation[]> {
    return [...this.#rows.values()];
  }

  async lockForAsset(assetId: AssetId): Promise<readonly WalletAllocation[]> {
    this.lockCount += 1;
    return this.listForAsset(assetId);
  }

  async upsert(allocation: WalletAllocation): Promise<void> {
    this.#rows.set(key(allocation.walletId, allocation.assetId), allocation);
  }

  async delete(walletId: WalletId, assetId: AssetId): Promise<void> {
    this.#rows.delete(key(walletId, assetId));
  }

  async deleteForWallet(walletId: WalletId): Promise<void> {
    for (const row of this.#rows.values()) {
      if (row.walletId === walletId) this.#rows.delete(key(row.walletId, row.assetId));
    }
  }

  /** Test setup helper — seeds a row without going through a use case. */
  seed(allocation: WalletAllocation): void {
    this.#rows.set(key(allocation.walletId, allocation.assetId), allocation);
  }
}

export class FakeWalletAssetRuleRepository implements WalletAssetRuleRepository {
  #rows = new Map<AssetId, WalletId>();

  async find(assetId: AssetId): Promise<WalletId | null> {
    return this.#rows.get(assetId) ?? null;
  }

  async set(assetId: AssetId, walletId: WalletId): Promise<void> {
    this.#rows.set(assetId, walletId);
  }

  async clear(assetId: AssetId): Promise<void> {
    this.#rows.delete(assetId);
  }

  async clearForWallet(walletId: WalletId): Promise<void> {
    for (const [assetId, wallet] of this.#rows.entries()) {
      if (wallet === walletId) this.#rows.delete(assetId);
    }
  }
}

export class FakePositionQueryPort implements PositionQueryPort {
  #rows = new Map<AssetId, AssetPositionQuery>();

  set(assetId: AssetId, quantity: Quantity, averageCost: Money): void {
    this.#rows.set(assetId, { assetId, quantity, averageCost });
  }

  async query(assetId: AssetId): Promise<AssetPositionQuery> {
    return (
      this.#rows.get(assetId) ?? { assetId, quantity: Quantity.zero(), averageCost: Money.zero() }
    );
  }

  async listHeld(): Promise<readonly AssetPositionQuery[]> {
    return [...this.#rows.values()].filter((row) => row.quantity.isPositive());
  }
}
