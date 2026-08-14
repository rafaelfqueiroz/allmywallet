import type { Clock } from '@/core/shared/clock';
import type { TransactionRepository } from '@/core/ledger/ports';
import type { PositionRepository } from '@/core/positions/ports';
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
}
