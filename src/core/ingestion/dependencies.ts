import type { BusinessDate, Clock } from '@/core/shared/clock';
import type { TransactionRepository } from '@/core/ledger/ports';
import type { PositionRepository } from '@/core/positions/ports';
import type { CorporateEventFactorReader } from '@/core/quotes/corporate-event-factors';
import type {
  AssetResolverPort,
  ClosePriceReader,
  FixedIncomeContractWriterPort,
  ImportBatchRepository,
  ImportRowRepository,
  InstitutionResolverPort,
  SubscriptionEvidenceReader,
} from '@/core/ingestion/ports';

/**
 * SPEC-005 BR-005-24 (#146) — the narrow part of B3's calendar reconciliation
 * needs to decide whether a buy or sale had reached D+2 on the confirmed
 * Posição date. The worker injects the existing B3 calendar; core depends only
 * on this capability (AR-01/AR-02), not on its adapter.
 */
export interface SettlementCalendar {
  /** True only where the adapter has an authoritative full-day calendar. */
  hasCompleteDataFor(date: BusinessDate): boolean;
  isTradingDay(date: BusinessDate): boolean;
}

/**
 * What every SPEC-005 use case needs, injected at the composition root
 * (AR-02) — the worker handler for `import.stage`/`import.commit`, and the
 * `(app)/import` server actions for staging preview reads and cancel.
 */
export interface IngestionDependencies {
  readonly batches: ImportBatchRepository;
  readonly rows: ImportRowRepository;
  readonly transactions: TransactionRepository;
  readonly positions: PositionRepository;
  readonly assets: AssetResolverPort;
  readonly institutions: InstitutionResolverPort;
  readonly fixedIncomeContracts: FixedIncomeContractWriterPort;
  readonly clock: Clock;
  readonly settlementCalendar: SettlementCalendar;
  /**
   * SPEC-005 BR-005-20b / SPEC-008 BR-008-29 (#113) — B3's published
   * share-ratio factors, read from the shared tables at commit. Fetching them
   * from B3 happens before the commit transaction, in the handler.
   */
  readonly corporateEventFactors: CorporateEventFactorReader;
  /** SPEC-005 BR-005-20d — the main asset's stored close, for pricing a resolved subscription. */
  readonly closePrices: ClosePriceReader;
  /** SPEC-005 BR-005-20d — stored exercise/credit evidence across one issuer's assets. */
  readonly subscriptionEvidence: SubscriptionEvidenceReader;
}
