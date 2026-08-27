import type { Clock } from '@/core/shared/clock';
import type { ConsentRepository } from '@/core/privacy/ports';
import type {
  GoalNotificationPort,
  WalletGoalRepository,
  WalletValuationPort,
} from '@/core/goals/ports';

/**
 * SPEC-019 — what every goals use case needs, injected at the composition
 * root (AR-02).
 *
 * `consents` is SPEC-004's repository, not a goals-local copy. BR-019-25's
 * opt-in *is* the `email_reminders` purpose (CONSENT_PURPOSES), and a second
 * consent store would be a second place a user's decision could be recorded —
 * which is the one thing LGPD compliance cannot survive.
 *
 * There is deliberately **no allocation-event port here.** The event history a
 * growth chart folds is read by the caller from SPEC-014's
 * `wallet_allocation_events` and passed in as an argument (AR-01: `core/` is
 * runnable with no database; if it needs data, the data arrives as an
 * argument). Declaring a third read port for a query that already exists on
 * `ReportDataPort` would be a port where there is no seam (AR-03).
 */
export interface GoalDependencies {
  readonly goals: WalletGoalRepository;
  readonly valuation: WalletValuationPort;
  readonly notifications: GoalNotificationPort;
  readonly consents: ConsentRepository;
  readonly clock: Clock;
}
