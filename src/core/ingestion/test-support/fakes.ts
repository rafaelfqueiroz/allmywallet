import { AssetId, ImportBatchId, InstitutionId } from '@/core/shared/ids';
import type { ImportRowId, TransactionId } from '@/core/shared/ids';
import type { BusinessDate } from '@/core/shared/clock';
import type { Money } from '@/core/shared/money';
import type { Transaction } from '@/core/ledger/transaction';
import { issuerCodeOf } from '@/core/ingestion/issuer-code';
import type {
  CorporateEventFactor,
  CorporateEventFactorReader,
} from '@/core/quotes/corporate-event-factors';
import type { AssetResolveInput } from '@/core/ingestion/ports';
import type { AssetDescriptor } from '@/core/ledger/test-support/fake-repositories';
import type {
  AssetResolverPort,
  ClosePriceReader,
  FixedIncomeContractWriterPort,
  ImportBatch,
  ImportBatchRepository,
  ImportRow,
  ImportRowAttentionCount,
  ImportRowRepository,
  InstitutionResolverPort,
  SubscriptionEvidenceReader,
  SubscriptionEvidenceRow,
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
  #descriptors = new Map<AssetId, AssetDescriptor>();

  /**
   * #145: the catalog a resolve writes, handed on so a fake ledger's `export`
   * joins the same code and class the real repository would — with #108's
   * rule that a stated class or name overwrites and a guessed one only fills.
   */
  readonly #onDescribe: ((id: AssetId, descriptor: AssetDescriptor) => void) | undefined;

  constructor(onDescribe?: (id: AssetId, descriptor: AssetDescriptor) => void) {
    this.#onDescribe = onDescribe;
  }

  async resolve(input: AssetResolveInput): Promise<AssetId> {
    const id = this.#byCode.get(input.code) ?? AssetId.generate();
    this.#byCode.set(input.code, id);
    const seen = this.#descriptors.get(id);
    const descriptor: AssetDescriptor = {
      code: input.code,
      name: seen === undefined || input.nameStated ? input.name : seen.name,
      assetClass: seen === undefined || input.classStated ? input.assetClass : seen.assetClass,
    };
    this.#descriptors.set(id, descriptor);
    this.#onDescribe?.(id, descriptor);
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

/**
 * SPEC-008 BR-008-29 — the shared factor table, in memory. Empty by default,
 * which is exactly a reader outage or an issuer B3 does not list: every ratio
 * row stays unconfirmed.
 */
export class FakeCorporateEventFactorReader implements CorporateEventFactorReader {
  #factors: CorporateEventFactor[] = [];
  readonly calls: (readonly string[])[] = [];

  seed(...factors: readonly CorporateEventFactor[]): void {
    this.#factors.push(...factors);
  }

  async listByIssuers(
    issuerCodes: readonly string[],
  ): Promise<ReadonlyMap<string, readonly CorporateEventFactor[]>> {
    this.calls.push(issuerCodes);
    const byIssuer = new Map<string, CorporateEventFactor[]>();
    for (const factor of this.#factors) {
      if (!issuerCodes.includes(factor.issuerCode)) continue;
      byIssuer.set(factor.issuerCode, [...(byIssuer.get(factor.issuerCode) ?? []), factor]);
    }
    return byIssuer;
  }
}

/**
 * SPEC-005 BR-005-20d — the shared `price_quotes` table, in memory. Empty by
 * default: a commit that finds no stored close for the credit date leaves the
 * pair `unclassified` (D1's "no invented price").
 */
export class FakeClosePriceReader implements ClosePriceReader {
  #closes: { assetId: AssetId; date: BusinessDate; close: Money }[] = [];
  readonly calls: { assetId: AssetId; date: BusinessDate }[] = [];

  seed(assetId: AssetId, date: BusinessDate, close: Money): void {
    this.#closes.push({ assetId, date, close });
  }

  async closeOnOrBefore(
    assetId: AssetId,
    date: BusinessDate,
  ): Promise<{ readonly date: BusinessDate; readonly close: Money } | null> {
    this.calls.push({ assetId, date });
    const candidates = this.#closes
      .filter((row) => row.assetId === assetId && row.date <= date)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const [nearest] = candidates;
    return nearest === undefined ? null : { date: nearest.date, close: nearest.close };
  }
}

/**
 * SPEC-005 BR-005-20d — stored transactions across one issuer's assets, in
 * memory. Seeded with the whole ledger a test wants visible to the resolver;
 * `issuerCodeOf` filters exactly as the Drizzle adapter's SQL LIKE plus
 * application filter does, so a fixture using a real B3 ticker shape behaves
 * the same against either implementation.
 */
export class FakeSubscriptionEvidenceReader implements SubscriptionEvidenceReader {
  #rows: { transaction: Transaction; assetCode: string }[] = [];

  seed(assetCode: string, transaction: Transaction): void {
    this.#rows.push({ transaction, assetCode });
  }

  async evidenceForIssuer(
    issuerRoot: string,
    institutionId: InstitutionId | null,
  ): Promise<readonly SubscriptionEvidenceRow[]> {
    return this.#rows.filter(
      (row) =>
        issuerCodeOf(row.assetCode) === issuerRoot &&
        row.transaction.institutionId === institutionId,
    );
  }
}
