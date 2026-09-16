import type { Clock } from '@/core/shared/clock';
import type { TransactionRepository } from '@/core/ledger/ports';
import type { PositionRepository } from '@/core/positions/ports';
import type { CorporateEventFactorReader } from '@/core/quotes/corporate-event-factors';
import type {
  AssetResolverPort,
  FixedIncomeContractWriterPort,
  ImportBatchRepository,
  ImportRowRepository,
  InstitutionResolverPort,
} from '@/core/ingestion/ports';

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
  /**
   * SPEC-005 BR-005-20b / SPEC-008 BR-008-29 (#113) — B3's published
   * share-ratio factors, read from the shared tables at commit. Fetching them
   * from B3 happens before the commit transaction, in the handler.
   */
  readonly corporateEventFactors: CorporateEventFactorReader;
}
