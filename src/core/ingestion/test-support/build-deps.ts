import { FakeClock } from '@/core/shared/clock';
import {
  FakePositionRepository,
  FakeTransactionRepository,
} from '@/core/ledger/test-support/fake-repositories';
import type { IngestionDependencies } from '@/core/ingestion/dependencies';
import {
  FakeAssetResolver,
  FakeCorporateEventFactorReader,
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
  readonly corporateEventFactors: FakeCorporateEventFactorReader;
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
    corporateEventFactors: new FakeCorporateEventFactorReader(),
  };
}

/**
 * #113 — the three corporate-event windows at the values the config registry
 * seeds (`import.corporate_event_factor_window_days` 7,
 * `import.fraction_origin_window_days` 45, `import.fraction_auction_window_days`
 * 180). Tests pass them explicitly, as the handler does; core has no default.
 */
export const TEST_CORPORATE_EVENT_WINDOWS = {
  factorDays: 7,
  originDays: 45,
  auctionDays: 180,
} as const;
