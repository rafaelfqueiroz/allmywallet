import { BusinessDate, FakeClock } from '@/core/shared/clock';
import {
  FakePositionRepository,
  FakeTransactionRepository,
} from '@/core/ledger/test-support/fake-repositories';
import type { IngestionDependencies, SettlementCalendar } from '@/core/ingestion/dependencies';
import {
  FakeAssetResolver,
  FakeClosePriceReader,
  FakeCorporateEventFactorReader,
  FakeFixedIncomeContractWriter,
  FakeImportBatchRepository,
  FakeImportRowRepository,
  FakeInstitutionResolver,
  FakeSubscriptionEvidenceReader,
} from '@/core/ingestion/test-support/fakes';

export interface FakeIngestionDeps extends IngestionDependencies {
  readonly batches: FakeImportBatchRepository;
  readonly rows: FakeImportRowRepository;
  readonly transactions: FakeTransactionRepository;
  readonly positions: FakePositionRepository;
  readonly assets: FakeAssetResolver;
  readonly institutions: FakeInstitutionResolver;
  readonly fixedIncomeContracts: FakeFixedIncomeContractWriter;
  readonly clock: FakeClock;
  readonly settlementCalendar: FakeSettlementCalendar;
  readonly corporateEventFactors: FakeCorporateEventFactorReader;
  readonly closePrices: FakeClosePriceReader;
  readonly subscriptionEvidence: FakeSubscriptionEvidenceReader;
}

/** TS-02: a controllable fake for the narrow D+2 calendar seam. */
export class FakeSettlementCalendar implements SettlementCalendar {
  #tradingDays: ReadonlySet<string> | null = null;
  #coveredYears: ReadonlySet<string> | null = null;

  hasCompleteDataFor(date: BusinessDate): boolean {
    return this.#coveredYears === null || this.#coveredYears.has(date.slice(0, 4));
  }

  /**
   * With no explicit dataset, ordinary weekdays are trading days. A focused
   * holiday/weekend test supplies the exact sessions it needs instead.
   */
  isTradingDay(date: BusinessDate): boolean {
    if (this.#tradingDays !== null) return this.#tradingDays.has(date);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    return weekday !== 0 && weekday !== 6;
  }

  setTradingDays(dates: readonly string[]): void {
    this.#tradingDays = new Set(dates.map((date) => BusinessDate.of(date)));
  }

  setCoveredYears(years: readonly string[]): void {
    this.#coveredYears = new Set(years);
  }
}

/** TS-02/TS-22: a builder with sensible defaults, so a test states only what it cares about. */
export function buildFakeIngestionDeps(today = '2026-03-15'): FakeIngestionDeps {
  const transactions = new FakeTransactionRepository();
  return {
    batches: new FakeImportBatchRepository(),
    rows: new FakeImportRowRepository(() => transactions.rows),
    transactions,
    positions: new FakePositionRepository(),
    assets: new FakeAssetResolver((id, descriptor) => transactions.describeAsset(id, descriptor)),
    institutions: new FakeInstitutionResolver(),
    fixedIncomeContracts: new FakeFixedIncomeContractWriter(),
    clock: new FakeClock(`${today}T12:00:00-03:00`),
    settlementCalendar: new FakeSettlementCalendar(),
    corporateEventFactors: new FakeCorporateEventFactorReader(),
    closePrices: new FakeClosePriceReader(),
    subscriptionEvidence: new FakeSubscriptionEvidenceReader(transactions),
  };
}

/**
 * #113 — the three corporate-event windows at the values the config registry
 * seeds (`import.corporate_event_factor_window_days` 7,
 * `import.fraction_origin_window_days` 60 — widened from 45 by #128 D1 —
 * `import.fraction_auction_window_days` 180). Tests pass them explicitly, as
 * the handler does; core has no default.
 */
export const TEST_CORPORATE_EVENT_WINDOWS = {
  factorDays: 7,
  originDays: 60,
  auctionDays: 180,
} as const;
