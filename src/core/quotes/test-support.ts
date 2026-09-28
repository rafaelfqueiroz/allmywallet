import type { BusinessDate } from '@/core/shared/clock';
import { AssetId } from '@/core/shared/ids';
import type { UserId } from '@/core/shared/ids';
import { err, ok, type Result } from '@/core/shared/result';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import { OfficialCloseSourceErrorCode, QuoteProviderErrorCode } from './ports';
import type {
  Asset,
  AssetCatalogPort,
  BudgetCounterPort,
  BudgetKind,
  BudgetUsage,
  CloseGap,
  CloseGapRepositoryPort,
  LatestCloseDatePort,
  HeldAssetsPort,
  IndexSeriesCode,
  IndexSeriesPointRecord,
  IndexSeriesProvider,
  LatestQuote,
  OfficialClose,
  OfficialClosesFile,
  OfficialCloseSource,
  PriceQuote,
  QuoteProvider,
  QuoteProviderResult,
  QuoteRateLimiter,
  QuoteRepositoryPort,
  TesouroPricePoint,
  TesouroPriceProvider,
  TradingCalendar,
  TradingSession,
  UnofficialClosesPort,
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

  async oldestLastCloseAmong(assetIds: readonly AssetId[]): Promise<BusinessDate | null> {
    const wanted = new Set(assetIds);
    const lastByAsset = new Map<AssetId, BusinessDate>();
    for (const quote of this.closes.values()) {
      if (!wanted.has(quote.assetId)) continue;
      const last = lastByAsset.get(quote.assetId);
      if (last === undefined || quote.date > last) lastByAsset.set(quote.assetId, quote.date);
    }
    let oldest: BusinessDate | null = null;
    for (const last of lastByAsset.values()) {
      if (oldest === null || last < oldest) oldest = last;
    }
    return oldest;
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

  /** SPEC-008 BR-008-09/BR-021-31 (#171) — a close COTAHIST no longer supplies must not stay in history. */
  async deleteClose(assetId: AssetId, date: BusinessDate): Promise<void> {
    this.closes.delete(`${assetId}:${date}`);
  }

  async earliestCloseFrom(assetId: AssetId, source: string): Promise<BusinessDate | null> {
    let earliest: BusinessDate | null = null;
    for (const quote of this.closes.values()) {
      if (quote.assetId !== assetId || quote.source !== source) continue;
      if (earliest === null || quote.date < earliest) earliest = quote.date;
    }
    return earliest;
  }

  /**
   * SPEC-009 BR-009-03 / SPEC-005 BR-005-20d — the carry-forward lookup
   * `PriceHistoryPort`/`ClosePriceReader` both declare it under: the close on
   * `date`, or the nearest earlier one however old (D2).
   */
  async getCloseOnOrBefore(assetId: AssetId, date: BusinessDate): Promise<PriceQuote | null> {
    let nearest: PriceQuote | null = null;
    for (const quote of this.closes.values()) {
      if (quote.assetId !== assetId || quote.date > date) continue;
      if (nearest === null || quote.date > nearest.date) nearest = quote;
    }
    return nearest;
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
  /** Every provider request — the figure budget assertions care about. */
  callCount = 0;
  calledTickers: string[] = [];
  /** SPEC-021 BR-021-33 (#171) — lets a catch-up test prove the live-quote path was never asked. */
  liveCallCount = 0;
  private readonly results = new Map<string, () => Result<QuoteProviderResult, DomainError>>();

  set(ticker: string, factory: () => Result<QuoteProviderResult, DomainError>): void {
    this.results.set(ticker, factory);
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

/**
 * TS-02 (#171) — `OfficialCloseSource`. Content is seeded per year (annual
 * file) and per day (daily file); `fetchDay`/`fetchYear` fall back to an
 * explicit NOT_PUBLISHED/UNAVAILABLE override when neither is seeded, so a
 * test can simulate "B3 has not published today's file yet" without seeding
 * an empty one (an empty file with a `lastDate` is a *published*, empty day
 * — a different outcome, per `OfficialClosesFile.lastDate`'s own doc comment).
 */
export class FakeOfficialCloseSource implements OfficialCloseSource {
  readonly source: string;
  readonly dayCalls: { readonly date: BusinessDate; readonly tickers: readonly string[] }[] = [];
  readonly yearCalls: { readonly year: number; readonly tickers: readonly string[] }[] = [];

  private readonly days = new Map<BusinessDate, OfficialClosesFile>();
  private readonly years = new Map<number, OfficialClosesFile>();
  private readonly dayErrors = new Map<BusinessDate, OfficialCloseSourceErrorCode>();
  private readonly yearErrors = new Map<number, OfficialCloseSourceErrorCode>();

  constructor(source = 'b3_cotahist') {
    this.source = source;
  }

  /** A published daily file: `lastDate` defaults to `date` itself. */
  seedDay(
    date: BusinessDate,
    closes: readonly OfficialClose[],
    lastDate: BusinessDate | null = date,
  ): void {
    this.days.set(date, { closes, lastDate });
    // A file published after an earlier failure: the retry reads it.
    this.dayErrors.delete(date);
  }

  seedDayError(date: BusinessDate, code: OfficialCloseSourceErrorCode): void {
    this.dayErrors.set(date, code);
  }

  seedYear(year: number, closes: readonly OfficialClose[], lastDate: BusinessDate | null): void {
    this.years.set(year, { closes, lastDate });
  }

  seedYearError(year: number, code: OfficialCloseSourceErrorCode): void {
    this.yearErrors.set(year, code);
  }

  async fetchDay(
    date: BusinessDate,
    tickers: ReadonlySet<string>,
  ): Promise<Result<OfficialClosesFile, DomainError>> {
    this.dayCalls.push({ date, tickers: [...tickers] });
    const errorCode = this.dayErrors.get(date);
    if (errorCode) return err(domainError(errorCode, { date }));
    const file = this.days.get(date);
    if (!file) return err(domainError(OfficialCloseSourceErrorCode.NOT_PUBLISHED, { date }));
    return ok({
      closes: file.closes.filter((c) => tickers.has(c.ticker)),
      lastDate: file.lastDate,
    });
  }

  async fetchYear(
    year: number,
    tickers: ReadonlySet<string>,
  ): Promise<Result<OfficialClosesFile, DomainError>> {
    this.yearCalls.push({ year, tickers: [...tickers] });
    const errorCode = this.yearErrors.get(year);
    if (errorCode) return err(domainError(errorCode, { year }));
    const file = this.years.get(year);
    if (!file) return err(domainError(OfficialCloseSourceErrorCode.NOT_PUBLISHED, { year }));
    return ok({
      closes: file.closes.filter((c) => tickers.has(c.ticker)),
      lastDate: file.lastDate,
    });
  }
}

/** TS-02 (#171) — `UnofficialClosesPort`, seeded directly with what the DB join would already have filtered. */
export class FakeUnofficialClosesPort implements UnofficialClosesPort {
  private entries: {
    readonly assetId: AssetId;
    readonly code: string;
    readonly date: BusinessDate;
    readonly source: string;
  }[] = [];

  seed(entry: { assetId: AssetId; code: string; date: BusinessDate; source: string }): void {
    this.entries.push(entry);
  }

  async listUnofficialListedCloses(
    officialSource: string,
  ): Promise<
    readonly { readonly assetId: AssetId; readonly code: string; readonly date: BusinessDate }[]
  > {
    return this.entries
      .filter((entry) => entry.source !== officialSource)
      .map(({ assetId, code, date }) => ({ assetId, code, date }));
  }

  private retryableGaps: {
    readonly assetId: AssetId;
    readonly code: string;
    readonly date: BusinessDate;
  }[] = [];

  seedRetryableGap(entry: { assetId: AssetId; code: string; date: BusinessDate }): void {
    this.retryableGaps.push(entry);
  }

  async listRetryableListedGaps(): Promise<
    readonly { readonly assetId: AssetId; readonly code: string; readonly date: BusinessDate }[]
  > {
    return [...this.retryableGaps];
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
    until: BusinessDate,
  ): Promise<Result<readonly IndexSeriesPointRecord[], DomainError>> {
    const points = (this.series.get(code) ?? []).filter((p) => p.date >= since && p.date <= until);
    return ok(points);
  }
}

export class FakeTesouroPriceProvider implements TesouroPriceProvider {
  points: readonly TesouroPricePoint[] = [];

  async fetchDailyPrices(): Promise<Result<readonly TesouroPricePoint[], DomainError>> {
    return ok(this.points);
  }
}
