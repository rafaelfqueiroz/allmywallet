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

export class FakeQuoteRepository implements QuoteRepositoryPort {
  private readonly latest = new Map<AssetId, LatestQuote>();
  private readonly closes = new Map<string, PriceQuote>();

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
  }
}

export class FakeQuoteProvider implements QuoteProvider {
  callCount = 0;
  calledTickers: string[] = [];
  private readonly results = new Map<string, () => Result<QuoteProviderResult, DomainError>>();

  set(ticker: string, factory: () => Result<QuoteProviderResult, DomainError>): void {
    this.results.set(ticker, factory);
  }

  async fetchQuote(ticker: string): Promise<Result<QuoteProviderResult, DomainError>> {
    this.callCount += 1;
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
