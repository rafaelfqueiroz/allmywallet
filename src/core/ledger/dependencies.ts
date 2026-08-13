import type { Clock } from '@/core/shared/clock';
import type { PositionRepository } from '@/core/positions/ports';
import type { TransactionRepository } from '@/core/ledger/ports';

/**
 * What every ledger use case needs, injected at the composition root (AR-02).
 *
 * The `Clock` is here rather than read from `Date.now()` because a trade date
 * is validated against "today" (BR-006-15) and a stored row carries created/
 * updated timestamps. Ambient time would make the same input validate
 * differently on a CI runner than on the VPS, which is the kind of
 * non-determinism that only shows up as a flaky test at midnight São Paulo
 * time.
 */
export interface LedgerDependencies {
  readonly transactions: TransactionRepository;
  readonly positions: PositionRepository;
  readonly clock: Clock;
}
