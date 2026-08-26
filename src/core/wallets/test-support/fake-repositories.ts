import type { AssetId, WalletId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type {
  AllocationChange,
  AllocationChangeCause,
  AssetPositionQuery,
  PositionQueryPort,
  StoredWalletTarget,
  WalletAllocation,
  WalletAllocationRepository,
  WalletAssetRuleRepository,
  WalletRepository,
  WalletTargetRepository,
  StandingRule,
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

  /**
   * SPEC-014 BR-014-12 — every allocation change, in order, as the real
   * repository appends them to `wallet_allocation_events`.
   *
   * Recorded by the fake rather than left to the integration suite because
   * the thing most likely to be wrong is the **date**, and the date is chosen
   * in `core/` — `applyBuy` gets the trade date, a manual assignment gets
   * today. A use-case test can assert that here; a database test would only
   * see whatever core decided.
   */
  readonly events: {
    walletId: WalletId;
    assetId: AssetId;
    quantity: string;
    effectiveOn: string;
    cause: AllocationChangeCause;
  }[] = [];

  async upsert(allocation: WalletAllocation, change: AllocationChange): Promise<void> {
    this.#rows.set(key(allocation.walletId, allocation.assetId), allocation);
    this.events.push({
      walletId: allocation.walletId,
      assetId: allocation.assetId,
      quantity: allocation.quantity.toString(),
      effectiveOn: change.effectiveOn,
      cause: change.cause,
    });
  }

  async delete(walletId: WalletId, assetId: AssetId, change: AllocationChange): Promise<void> {
    this.#rows.delete(key(walletId, assetId));
    // Zero, not absent: "this wallet holds none of this asset from here" is
    // the fact the fold needs. A missing row would leave the last positive
    // quantity standing for every later date.
    this.events.push({
      walletId,
      assetId,
      quantity: '0',
      effectiveOn: change.effectiveOn,
      cause: change.cause,
    });
  }

  async deleteForWallet(walletId: WalletId, change: AllocationChange): Promise<void> {
    for (const row of this.#rows.values()) {
      if (row.walletId !== walletId) continue;
      this.#rows.delete(key(row.walletId, row.assetId));
      this.events.push({
        walletId,
        assetId: row.assetId,
        quantity: '0',
        effectiveOn: change.effectiveOn,
        cause: change.cause,
      });
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

  async list(): Promise<readonly StandingRule[]> {
    return [...this.#rows.entries()].map(([assetId, walletId]) => ({ assetId, walletId }));
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

/**
 * SPEC-017 — the target set, in memory.
 *
 * `lockCount` mirrors `FakeWalletAllocationRepository.lockCount`: BR-017-04's
 * 100 % invariant is only safe if every write path reads under the lock first,
 * and that is a property of `core/`'s control flow, not of the SQL. A use-case
 * test can assert it here; the real `SELECT ... FOR UPDATE` is proven against
 * concurrent Postgres in `tests/integration/wallet-target-invariant.test.ts`.
 */
export class FakeWalletTargetRepository implements WalletTargetRepository {
  #rows = new Map<string, StoredWalletTarget>();

  lockCount = 0;

  async listForWallet(walletId: WalletId): Promise<readonly StoredWalletTarget[]> {
    return [...this.#rows.values()].filter((row) => row.walletId === walletId);
  }

  async listAll(): Promise<readonly StoredWalletTarget[]> {
    return [...this.#rows.values()];
  }

  async lockForWallet(walletId: WalletId): Promise<readonly StoredWalletTarget[]> {
    this.lockCount += 1;
    return this.listForWallet(walletId);
  }

  async replaceForWallet(
    walletId: WalletId,
    targets: readonly StoredWalletTarget[],
  ): Promise<void> {
    for (const row of [...this.#rows.values()]) {
      if (row.walletId === walletId) this.#rows.delete(key(row.walletId, row.assetId));
    }
    for (const target of targets) {
      this.#rows.set(key(target.walletId, target.assetId), target);
    }
  }

  /** Test setup helper — seeds rows without going through a use case. */
  seed(...targets: readonly StoredWalletTarget[]): void {
    for (const target of targets) this.#rows.set(key(target.walletId, target.assetId), target);
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
