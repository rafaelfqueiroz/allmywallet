import { AssetId, ImportBatchId, InstitutionId } from '@/core/shared/ids';
import type { ImportRowId, TransactionId } from '@/core/shared/ids';
import type { AssetResolveInput } from '@/core/ingestion/ports';
import type {
  AssetResolverPort,
  FixedIncomeContractWriterPort,
  ImportBatch,
  ImportBatchRepository,
  ImportRow,
  ImportRowAttentionCount,
  ImportRowRepository,
  InstitutionResolverPort,
} from '@/core/ingestion/ports';

/**
 * TS-02: hand-written fakes implementing the real port interfaces, used by
 * `core/ingestion/*.test.ts` so those use-case tests never touch a database
 * (TS-01) — the SQL these stand in for is exercised for real in
 * `tests/integration/`.
 */

export class FakeImportBatchRepository implements ImportBatchRepository {
  #batches = new Map<string, ImportBatch>();

  seed(batch: ImportBatch): void {
    this.#batches.set(batch.id, batch);
  }

  async insert(batch: ImportBatch): Promise<void> {
    this.#batches.set(batch.id, batch);
  }

  async findById(id: ImportBatchId): Promise<ImportBatch | null> {
    return this.#batches.get(id) ?? null;
  }

  async update(batch: ImportBatch): Promise<void> {
    this.#batches.set(batch.id, batch);
  }

  async listCommitted(): Promise<readonly ImportBatch[]> {
    return [...this.#batches.values()].filter((b) => b.status === 'committed');
  }

  async listAll(): Promise<readonly ImportBatch[]> {
    return [...this.#batches.values()].sort(
      (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime(),
    );
  }
}

export class FakeImportRowRepository implements ImportRowRepository {
  #rows = new Map<string, ImportRow>();

  get all(): readonly ImportRow[] {
    return [...this.#rows.values()];
  }

  async insertMany(rows: readonly ImportRow[]): Promise<void> {
    for (const row of rows) this.#rows.set(row.id, row);
  }

  async findById(id: ImportRowId): Promise<ImportRow | null> {
    return this.#rows.get(id) ?? null;
  }

  async listByBatch(batchId: ImportBatchId): Promise<readonly ImportRow[]> {
    return [...this.#rows.values()].filter((row) => row.batchId === batchId);
  }

  /**
   * The fake has no batch table to join, so it cannot honour the adapter's
   * committed-only filter — every seeded row counts. Stated rather than hidden:
   * the filter is a SQL fact and `tests/integration/dashboard.test.ts` is what
   * proves it, which is where a join belongs (TS-30).
   */
  async countNeedsAttentionByBatch(): Promise<readonly ImportRowAttentionCount[]> {
    const counts = new Map<string, number>();
    for (const row of this.#rows.values()) {
      if (row.classification !== 'unclassified' && row.classification !== 'invalid') continue;
      counts.set(row.batchId, (counts.get(row.batchId) ?? 0) + 1);
    }
    return [...counts].map(([batchId, count]) => ({
      batchId: ImportBatchId.of(batchId),
      count,
    }));
  }

  async deleteByBatch(batchId: ImportBatchId): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.#rows) {
      if (row.batchId === batchId) {
        this.#rows.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async attachTransactions(updates: ReadonlyMap<ImportRowId, TransactionId>): Promise<void> {
    for (const [rowId, transactionId] of updates) {
      const row = this.#rows.get(rowId);
      if (row) this.#rows.set(rowId, { ...row, transactionId });
    }
  }

  async updateClassification(
    id: ImportRowId,
    classification: ImportRow['classification'],
  ): Promise<void> {
    const row = this.#rows.get(id);
    if (row) this.#rows.set(id, { ...row, classification });
  }

  async listInvalidByNaturalKeys(keys: readonly string[]): Promise<readonly ImportRow[]> {
    const wanted = new Set(keys);
    return [...this.#rows.values()].filter(
      (row) =>
        row.classification === 'invalid' && row.naturalKey !== null && wanted.has(row.naturalKey),
    );
  }
}

/** Upserts by `code`, mirroring `DrizzleAssetCatalogRepository.upsertByCode`'s behaviour. */
export class FakeAssetResolver implements AssetResolverPort {
  #byCode = new Map<string, AssetId>();

  async resolve(input: AssetResolveInput): Promise<AssetId> {
    const existing = this.#byCode.get(input.code);
    if (existing) return existing;
    const id = AssetId.generate();
    this.#byCode.set(input.code, id);
    return id;
  }
}

export class FakeInstitutionResolver implements InstitutionResolverPort {
  #byName = new Map<string, InstitutionId>();

  async resolve(name: string): Promise<InstitutionId> {
    const existing = this.#byName.get(name);
    if (existing) return existing;
    const id = InstitutionId.generate();
    this.#byName.set(name, id);
    return id;
  }
}

export class FakeFixedIncomeContractWriter implements FixedIncomeContractWriterPort {
  calls: Parameters<FixedIncomeContractWriterPort['upsertByAsset']>[0][] = [];

  async upsertByAsset(
    input: Parameters<FixedIncomeContractWriterPort['upsertByAsset']>[0],
  ): Promise<void> {
    this.calls.push(input);
  }
}
