import { BusinessDate } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type {
  DailyValuationSnapshot,
  FixedIncomeContract,
  FixedIncomeContractPort,
  FixedIncomeIndexer,
  IndexSeriesCode,
  IndexSeriesPoint,
  IndexSeriesReaderPort,
  LatestQuote,
  PriceHistoryPort,
  PriceQuote,
  SnapshotRepositoryPort,
} from '@/core/valuation/ports';

/**
 * TS-02 — hand-written fakes implementing the real port interfaces. Not a
 * mocking library: when a port's shape changes these stop compiling, whereas a
 * mock would carry on lying about a contract that no longer exists.
 *
 * `FakeAssetCatalog` is not redefined here — `@/core/quotes/test-support`
 * already has one and valuation uses the same `AssetCatalogPort`.
 */

/** A published index point. `percent` is the value as published: `0.05078803` is 0,05078803 % per day. */
export function indexPoint(date: string, percent: string): IndexSeriesPoint {
  return { date: BusinessDate.of(date), value: Quantity.fromString(percent) };
}

export interface ContractOverrides {
  readonly indexer?: FixedIncomeIndexer | null;
  readonly ratePercent?: string | null;
  readonly issueDate?: string;
  readonly maturityDate?: string | null;
  readonly principal?: string;
}

export function aContract(
  assetId: AssetId,
  overrides: ContractOverrides = {},
): FixedIncomeContract {
  const maturity = overrides.maturityDate === undefined ? null : overrides.maturityDate;
  return {
    assetId,
    indexer: overrides.indexer === undefined ? 'cdi_percent' : overrides.indexer,
    ratePercent:
      overrides.ratePercent === undefined
        ? Quantity.fromString('110')
        : overrides.ratePercent === null
          ? null
          : Quantity.fromString(overrides.ratePercent),
    issueDate: BusinessDate.of(overrides.issueDate ?? '2026-03-16'),
    maturityDate: maturity === null ? null : BusinessDate.of(maturity),
    principal: Money.fromString(overrides.principal ?? '10000'),
  };
}

export class FakeFixedIncomeContracts implements FixedIncomeContractPort {
  readonly lookups: AssetId[] = [];
  readonly #byAsset = new Map<AssetId, FixedIncomeContract>();

  set(contract: FixedIncomeContract): this {
    this.#byAsset.set(contract.assetId, contract);
    return this;
  }

  async findByAssetId(assetId: AssetId): Promise<FixedIncomeContract | null> {
    this.lookups.push(assetId);
    return this.#byAsset.get(assetId) ?? null;
  }
}

export class FakeIndexSeriesReader implements IndexSeriesReaderPort {
  readonly requests: { code: IndexSeriesCode; from: BusinessDate; to: BusinessDate }[] = [];
  readonly #series = new Map<IndexSeriesCode, readonly IndexSeriesPoint[]>();

  set(code: IndexSeriesCode, points: readonly IndexSeriesPoint[]): this {
    this.#series.set(code, points);
    return this;
  }

  async listPoints(
    code: IndexSeriesCode,
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<readonly IndexSeriesPoint[]> {
    this.requests.push({ code, from, to });
    return (this.#series.get(code) ?? []).filter((point) => point.date >= from && point.date <= to);
  }
}

export class FakePriceHistory implements PriceHistoryPort {
  readonly #closes = new Map<AssetId, PriceQuote[]>();
  readonly #latest = new Map<AssetId, LatestQuote>();

  addClose(assetId: AssetId, date: string, close: string, source = 'test'): this {
    const history = this.#closes.get(assetId) ?? [];
    history.push({ assetId, date: BusinessDate.of(date), close: Money.fromString(close), source });
    history.sort((a, b) => BusinessDate.compare(a.date, b.date));
    this.#closes.set(assetId, history);
    return this;
  }

  setLatest(assetId: AssetId, price: string, quotedAt: string, source = 'test'): this {
    this.#latest.set(assetId, {
      assetId,
      price: Money.fromString(price),
      quotedAt: new Date(quotedAt),
      fetchedAt: new Date(quotedAt),
      source,
    });
    return this;
  }

  async getCloseOnOrBefore(assetId: AssetId, date: BusinessDate): Promise<PriceQuote | null> {
    const history = this.#closes.get(assetId) ?? [];
    let found: PriceQuote | null = null;
    for (const quote of history) {
      if (BusinessDate.isAfter(quote.date, date)) break;
      found = quote;
    }
    return found;
  }

  async listCloses(
    assetId: AssetId,
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<readonly PriceQuote[]> {
    return (this.#closes.get(assetId) ?? []).filter(
      (quote) => quote.date >= from && quote.date <= to,
    );
  }

  async getLatestQuote(assetId: AssetId): Promise<LatestQuote | null> {
    return this.#latest.get(assetId) ?? null;
  }
}

export class FakeSnapshotRepository implements SnapshotRepositoryPort {
  readonly deleteCalls: BusinessDate[] = [];
  readonly rows = new Map<BusinessDate, DailyValuationSnapshot>();

  async upsertMany(snapshots: readonly DailyValuationSnapshot[]): Promise<void> {
    for (const snapshot of snapshots) this.rows.set(snapshot.date, snapshot);
  }

  async deleteFrom(date: BusinessDate): Promise<number> {
    this.deleteCalls.push(date);
    let removed = 0;
    for (const key of [...this.rows.keys()]) {
      if (!BusinessDate.isBefore(key, date)) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async listRange(
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<readonly DailyValuationSnapshot[]> {
    return [...this.rows.values()]
      .filter((snapshot) => snapshot.date >= from && snapshot.date <= to)
      .sort((a, b) => BusinessDate.compare(a.date, b.date));
  }
}
