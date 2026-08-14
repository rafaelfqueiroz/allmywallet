import { FakeClock } from '@/core/shared/clock';
import {
  FakePositionRepository,
  FakeTransactionRepository,
} from '@/core/ledger/test-support/fake-repositories';
import type { IngestionDependencies } from '@/core/ingestion/dependencies';
import {
  FakeAssetResolver,
  FakeFixedIncomeContractWriter,
  FakeImportBatchRepository,
  FakeImportRowRepository,
  FakeInstitutionResolver,
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
}

/** TS-02/TS-22: a builder with sensible defaults, so a test states only what it cares about. */
export function buildFakeIngestionDeps(today = '2026-03-15'): FakeIngestionDeps {
  return {
    batches: new FakeImportBatchRepository(),
    rows: new FakeImportRowRepository(),
    transactions: new FakeTransactionRepository(),
    positions: new FakePositionRepository(),
    assets: new FakeAssetResolver(),
    institutions: new FakeInstitutionResolver(),
    fixedIncomeContracts: new FakeFixedIncomeContractWriter(),
    clock: new FakeClock(`${today}T12:00:00-03:00`),
  };
}
