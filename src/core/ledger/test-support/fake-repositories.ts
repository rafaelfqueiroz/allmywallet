import type { AssetId, InstitutionId, TransactionId } from '@/core/shared/ids';
import type {
  Pagination,
  TransactionFilter,
  TransactionListItem,
  TransactionPage,
  TransactionRepository,
} from '@/core/ledger/ports';
import type { Transaction } from '@/core/ledger/transaction';
import type { PositionRepository } from '@/core/positions/ports';
import {
  positionKeyString,
  type PositionKey,
  type PositionSnapshot,
} from '@/core/positions/replay';

/**
 * TS-02: hand-written fakes implementing the **real** port interfaces, not
 * mocking-library doubles. When `TransactionRepository` changes, these stop
 * compiling; a mock would carry on lying.
 *
 * TS-01: they exist so use-case tests never touch a database. The SQL these
 * stand in for is exercised for real in `tests/integration/`, which is where
 * filter semantics and NUMERIC round-tripping are actually proven.
 */

export interface AssetDescriptor {
  readonly code: string;
  readonly name: string;
  readonly assetClass: string;
}

export class FakeTransactionRepository implements TransactionRepository {
  #rows: Transaction[];
  readonly #assets = new Map<AssetId, AssetDescriptor>();
  readonly #institutions = new Map<InstitutionId, string>();

  /** Counts writes, so a test can prove a refused operation wrote nothing. */
  insertCount = 0;
  updateCount = 0;
  deleteCount = 0;

  constructor(rows: readonly Transaction[] = []) {
    this.#rows = [...rows];
  }

  describeAsset(assetId: AssetId, descriptor: AssetDescriptor): void {
    this.#assets.set(assetId, descriptor);
  }

  describeInstitution(institutionId: InstitutionId, name: string): void {
    this.#institutions.set(institutionId, name);
  }

  get rows(): readonly Transaction[] {
    return this.#rows;
  }

  async findById(id: TransactionId): Promise<Transaction | null> {
    return this.#rows.find((row) => row.id === id) ?? null;
  }

  async listForPosition(
    assetId: AssetId,
    institutionId: InstitutionId | null,
  ): Promise<readonly Transaction[]> {
    return this.#rows.filter(
      (row) => row.assetId === assetId && row.institutionId === institutionId,
    );
  }

  async listAll(): Promise<readonly Transaction[]> {
    return [...this.#rows];
  }

  async search(_filter: TransactionFilter, pagination: Pagination): Promise<TransactionPage> {
    // Filter semantics belong to SQL and are integration-tested; what the unit
    // tests need from this method is that the page window is applied and the
    // total reflects the whole match, not the page.
    const items = this.#rows.slice(pagination.offset, pagination.offset + pagination.limit);
    return { items: items.map((row) => this.#toListItem(row)), total: this.#rows.length };
  }

  async export(_filter: TransactionFilter): Promise<readonly TransactionListItem[]> {
    return this.#rows.map((row) => this.#toListItem(row));
  }

  async insert(transaction: Transaction): Promise<void> {
    this.insertCount += 1;
    this.#rows.push(transaction);
  }

  async insertMany(rows: readonly Transaction[]): Promise<void> {
    // Counted as one write, because it is one: a test asserting "a refused
    // commit wrote nothing" cares about statements, not rows.
    this.insertCount += 1;
    this.#rows.push(...rows);
  }

  async update(transaction: Transaction): Promise<void> {
    this.updateCount += 1;
    this.#rows = this.#rows.map((row) => (row.id === transaction.id ? transaction : row));
  }

  async deleteByIds(ids: readonly TransactionId[]): Promise<number> {
    this.deleteCount += 1;
    const removing = new Set<string>(ids);
    const before = this.#rows.length;
    this.#rows = this.#rows.filter((row) => !removing.has(row.id));
    return before - this.#rows.length;
  }

  async nextOccurrence(naturalKey: string): Promise<number> {
    const highest = this.#rows
      .filter((row) => row.naturalKey === naturalKey)
      .reduce((max, row) => (row.occurrence > max ? row.occurrence : max), 0);
    return highest + 1;
  }

  async occurrenceCounts(naturalKeys: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const wanted = new Set(naturalKeys);
    const counts = new Map<string, number>();
    for (const row of this.#rows) {
      if (!wanted.has(row.naturalKey)) continue;
      const current = counts.get(row.naturalKey) ?? 0;
      if (row.occurrence > current) counts.set(row.naturalKey, row.occurrence);
    }
    return counts;
  }

  #toListItem(row: Transaction): TransactionListItem {
    const asset = this.#assets.get(row.assetId);
    return {
      transaction: row,
      assetCode: asset?.code ?? 'UNKNOWN',
      assetName: asset?.name ?? 'Unknown',
      assetClass: asset?.assetClass ?? 'stock',
      institutionName:
        row.institutionId === null ? null : (this.#institutions.get(row.institutionId) ?? null),
    };
  }
}

export class FakePositionRepository implements PositionRepository {
  #byKey = new Map<string, PositionSnapshot>();

  replaceAllCount = 0;
  upsertCount = 0;
  deleteCount = 0;

  async list(): Promise<readonly PositionSnapshot[]> {
    return [...this.#byKey.values()].sort((a, b) =>
      positionKeyString(a) < positionKeyString(b) ? -1 : 1,
    );
  }

  async upsertMany(snapshots: readonly PositionSnapshot[]): Promise<void> {
    this.upsertCount += 1;
    for (const snapshot of snapshots) {
      this.#byKey.set(positionKeyString(snapshot), snapshot);
    }
  }

  async deleteMany(keys: readonly PositionKey[]): Promise<void> {
    this.deleteCount += 1;
    for (const key of keys) {
      this.#byKey.delete(positionKeyString(key));
    }
  }

  async replaceAll(snapshots: readonly PositionSnapshot[]): Promise<void> {
    this.replaceAllCount += 1;
    this.#byKey = new Map(snapshots.map((snapshot) => [positionKeyString(snapshot), snapshot]));
  }
}
