import type { BusinessDate } from '@/core/shared/clock';
import { AssetId } from '@/core/shared/ids';
import type { UserId } from '@/core/shared/ids';
import { err, ok, type Result } from '@/core/shared/result';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import { QuoteProviderErrorCode } from './ports';
import type {
  Asset,
  AssetCatalogPort,
  BudgetCounterPort,
  BudgetKind,
  BudgetUsage,
  CloseGap,
  CloseGapRepositoryPort,
  HistoricalClosesResult,
  LatestCloseDatePort,
  HeldAssetsPort,
  IndexSeriesCode,
  IndexSeriesPointRecord,
  IndexSeriesProvider,
  LatestQuote,
  PriceQuote,
  QuoteProvider,
  QuoteProviderResult,
  QuoteRateLimiter,
  QuoteRepositoryPort,
  TesouroPricePoint,
  TesouroPriceProvider,
  TradingCalendar,
  TradingSession,
} from './ports';

/**
 * TS-02: hand-written fakes implementing the real port interfaces, shared
 * across this directory's use-case tests. Not a mocking library — when a
 * port's shape changes, these stop compiling instead of silently lying.
 */

export class FakeTradingCalendar implements TradingCalendar {
  sessionOpenOverride: boolean | undefined;
  #tradingDays: Set<string>;

  constructor(tradingDays: readonly string[] = []) {
    this.#tradingDays = new Set(tradingDays);
  }

  isTradingDay(date: BusinessDate): boolean {
    return this.#tradingDays.has(date);
  }

  sessionFor(date: BusinessDate): TradingSession | undefined {
    if (!this.isTradingDay(date)) return undefined;
    return {
      date,
      openUtc: new Date(`${date}T13:00:00Z`),
      closeUtc: new Date(`${date}T20:00:00Z`),
      isHalfSession: false,
    };
  }

  isSessionOpen(instant: Date): boolean {
    if (this.sessionOpenOverride !== undefined) return this.sessionOpenOverride;
    const date = instant.toISOString().slice(0, 10) as BusinessDate;
    const session = this.sessionFor(date);
    if (!session) return false;
    return instant >= session.openUtc && instant < session.closeUtc;
  }

  regularSessionMinutes(): number {
    return 420;
  }

  tradingDaysInMonth(yearMonth: string): number {
    return Array.from(this.#tradingDays).filter((d) => d.startsWith(yearMonth)).length;
  }
}

export class FakeAssetCatalog implements AssetCatalogPort {
  private readonly byCode = new Map<string, Asset>();
  private readonly byId = new Map<AssetId, Asset>();

  add(asset: Asset): void {
    this.byCode.set(asset.code, asset);
    this.byId.set(asset.id, asset);
  }

  async findByCode(code: string): Promise<Asset | null> {
    return this.byCode.get(code) ?? null;
  }

  async findById(id: AssetId): Promise<Asset | null> {
    return this.byId.get(id) ?? null;
  }

  async findByIds(ids: readonly AssetId[]): Promise<readonly Asset[]> {
    return ids.map((id) => this.byId.get(id)).filter((a): a is Asset => a !== undefined);
  }

  async upsertByCode(input: {
    code: string;
    name: string;
    assetClass: Asset['assetClass'];
  }): Promise<Asset> {
    const existing = this.byCode.get(input.code);
    const asset: Asset = existing
      ? { ...existing, name: input.name, assetClass: input.assetClass }
      : {
          id: AssetId.generate(),
          code: input.code,
          name: input.name,
          assetClass: input.assetClass,
        };
    this.add(asset);
    return asset;
  }
}

export class FakeHeldAssetsPort implements HeldAssetsPort {
  constructor(private ids: readonly AssetId[] = []) {}

  set(ids: readonly AssetId[]): void {
    this.ids = ids;
  }

  async listDistinctHeldAssetIds(): Promise<readonly AssetId[]> {
    return this.ids;
  }
}

export class FakeQuoteRepository implements QuoteRepositoryPort, LatestCloseDatePort {
  private readonly latest = new Map<AssetId, LatestQuote>();
  private readonly closes = new Map<string, PriceQuote>();

  /** Every close written, in write order — lets a test assert *what* was written, not only the end state. */
  readonly closeWrites: PriceQuote[] = [];

  async latestCloseDateAmong(assetIds: readonly AssetId[]): Promise<BusinessDate | null> {
    const wanted = new Set(assetIds);
    let latest: BusinessDate | null = null;
    for (const quote of this.closes.values()) {
      if (wanted.has(quote.assetId) && (latest === null || quote.date > latest)) {
        latest = quote.date;
      }
    }
    return latest;
  }

  async getLatestQuote(assetId: AssetId): Promise<LatestQuote | null> {
    return this.latest.get(assetId) ?? null;
  }

  async upsertLatestQuote(quote: LatestQuote): Promise<void> {
    this.latest.set(quote.assetId, quote);
  }

  async getClosePrice(assetId: AssetId, date: BusinessDate): Promise<PriceQuote | null> {
    return this.closes.get(`${assetId}:${date}`) ?? null;
  }

  async upsertClosePrice(quote: PriceQuote): Promise<void> {
    this.closes.set(`${quote.assetId}:${quote.date}`, quote);
    this.closeWrites.push(quote);
  }
}

/** SPEC-021 BR-021-31 — gaps keyed `(assetId, date)`, the same key the table uses. */
export class FakeCloseGapRepository implements CloseGapRepositoryPort {
  readonly gaps = new Map<string, CloseGap>();
  readonly cleared: string[] = [];

  async recordGap(gap: CloseGap): Promise<void> {
    this.gaps.set(`${gap.assetId}:${gap.date}`, gap);
  }

  async clearGap(assetId: AssetId, date: BusinessDate): Promise<void> {
    this.cleared.push(`${assetId}:${date}`);
    this.gaps.delete(`${assetId}:${date}`);
  }
}

export class FakeQuoteProvider implements QuoteProvider {
  /** Every provider request, live or historical — the figure budget assertions care about. */
  callCount = 0;
  calledTickers: string[] = [];
  historicalCalls: { ticker: string; from: BusinessDate; to: BusinessDate }[] = [];
  /** SPEC-021 BR-021-33 — lets a catch-up test prove the live-quote path was never asked. */
  liveCallCount = 0;
  private readonly results = new Map<string, () => Result<QuoteProviderResult, DomainError>>();
  private readonly histories = new Map<
    string,
    (from: BusinessDate, to: BusinessDate) => Result<HistoricalClosesResult, DomainError>
  >();

  set(ticker: string, factory: () => Result<QuoteProviderResult, DomainError>): void {
    this.results.set(ticker, factory);
  }

  setHistory(
    ticker: string,
    factory: (from: BusinessDate, to: BusinessDate) => Result<HistoricalClosesResult, DomainError>,
  ): void {
    this.histories.set(ticker, factory);
  }

  async fetchHistoricalCloses(
    ticker: string,
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<Result<HistoricalClosesResult, DomainError>> {
    this.callCount += 1;
    this.historicalCalls.push({ ticker, from, to });
    const factory = this.histories.get(ticker);
    if (!factory) {
      return err(domainError(QuoteProviderErrorCode.NOT_FOUND, { ticker }));
    }
    return factory(from, to);
  }

  async fetchQuote(ticker: string): Promise<Result<QuoteProviderResult, DomainError>> {
    this.callCount += 1;
    this.liveCallCount += 1;
    this.calledTickers.push(ticker);
    const factory = this.results.get(ticker);
    if (!factory) {
      return err(domainError(QuoteProviderErrorCode.NOT_FOUND, { ticker }));
    }
    return factory();
  }
}

export class FakeBudgetCounter implements BudgetCounterPort {
  private readonly usage = new Map<string, BudgetUsage>();
  incrementCalls: { yearMonth: string; kind: BudgetKind }[] = [];

  seed(yearMonth: string, usage: BudgetUsage): void {
    this.usage.set(yearMonth, usage);
  }

  async getUsage(yearMonth: string): Promise<BudgetUsage> {
    return this.usage.get(yearMonth) ?? { scheduled: 0, ondemand: 0 };
  }

  async increment(yearMonth: string, kind: BudgetKind): Promise<void> {
    this.incrementCalls.push({ yearMonth, kind });
    const current = this.usage.get(yearMonth) ?? { scheduled: 0, ondemand: 0 };
    this.usage.set(yearMonth, {
      scheduled: current.scheduled + (kind === 'scheduled' ? 1 : 0),
      ondemand: current.ondemand + (kind === 'ondemand' ? 1 : 0),
    });
  }
}

export class FakeQuoteRateLimiter implements QuoteRateLimiter {
  allow = true;
  consumedFor: UserId[] = [];

  tryConsume(userId: UserId): boolean {
    this.consumedFor.push(userId);
    return this.allow;
  }
}

export class FakeIndexSeriesProvider implements IndexSeriesProvider {
  private readonly series = new Map<string, readonly IndexSeriesPointRecord[]>();

  set(code: IndexSeriesCode, points: readonly IndexSeriesPointRecord[]): void {
    this.series.set(code, points);
  }

  async fetchSeries(
    code: IndexSeriesCode,
    since: BusinessDate,
  ): Promise<Result<readonly IndexSeriesPointRecord[], DomainError>> {
    const points = (this.series.get(code) ?? []).filter((p) => p.date >= since);
    return ok(points);
  }
}

export class FakeTesouroPriceProvider implements TesouroPriceProvider {
  points: readonly TesouroPricePoint[] = [];

  async fetchDailyPrices(): Promise<Result<readonly TesouroPricePoint[], DomainError>> {
    return ok(this.points);
  }
}
