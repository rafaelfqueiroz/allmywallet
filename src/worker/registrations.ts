import { QUEUE, type QueueName } from '@/worker/queues';
import { handleQuotesCloseCapture, handleQuotesPoll } from '@/worker/handlers/quotes';
import { handleTesouroSync } from '@/worker/handlers/tesouro';
import { handleBcbSync } from '@/worker/handlers/bcb';
import { handleBudgetCheck } from '@/worker/handlers/budget';
import { handleFixedIncomeAccrue, handleValuationSnapshot } from '@/worker/handlers/valuation';
import { handleImportCommit, handleImportStage } from '@/worker/handlers/import';
import {
  handleAccountDeletionSweep,
  handleAuditRetentionSweep,
} from '@/worker/handlers/account-deletion';
import { handleOpportunityEvaluate } from '@/worker/handlers/opportunity';

/**
 * Split out of `src/worker/index.ts` so this list — pure data plus handler
 * references — can be imported by a unit test without pulling in
 * `index.ts`'s `if (process.argv[1]?.includes('worker')) { main() }`
 * auto-start guard, which under some test runners' own process naming can
 * evaluate true and attempt a real `pg-boss` connection. `index.ts` re-
 * exports everything from here, so nothing about its own public surface
 * changes.
 */
export type JobHandler<T extends object> = (payload: T) => Promise<void>;

export interface RegisteredWorker {
  readonly queue: QueueName;
  readonly handler: JobHandler<never>;
  /** AR-17: cron is registered with `tz: 'America/Sao_Paulo'` — market hours are local. */
  readonly cron?: string;
}

/**
 * Each spec appends its worker registration here. Kept as a list rather than
 * scattered `boss.work` calls so the set of scheduled work is readable in one
 * place — which is what makes AR-16 checkable.
 *
 * SPEC-008: every cron here fires far more often (or, for the daily jobs,
 * independently of) than the rule it serves actually needs — AR-18 is why:
 * cron cannot express B3 holidays or half-sessions, so each handler
 * (`src/worker/handlers/`) re-checks the trading calendar (and, for
 * `quotes.poll`, per-asset freshness) itself and exits early. `quotes.poll`
 * firing every 5 minutes does not mean 5-minute polling — the effective
 * cadence (`quotes.cadence_minutes`, degradable per BR-008-22) is what
 * throttles actual provider calls.
 */
export const REGISTRATIONS: readonly RegisteredWorker[] = [
  {
    queue: QUEUE.QUOTES_POLL,
    handler: handleQuotesPoll,
    cron: '*/5 * * * *',
  },
  {
    queue: QUEUE.QUOTES_CLOSE_CAPTURE,
    handler: handleQuotesCloseCapture,
    // 17:05 — shortly after the regular B3 session's 17:00 close.
    cron: '5 17 * * 1-5',
  },
  {
    queue: QUEUE.TESOURO_SYNC,
    handler: handleTesouroSync,
    cron: '30 18 * * 1-5',
  },
  {
    queue: QUEUE.BCB_SYNC,
    handler: handleBcbSync,
    cron: '0 19 * * 1-5',
  },
  {
    queue: QUEUE.BUDGET_CHECK,
    handler: handleBudgetCheck,
    cron: '*/15 * * * *',
  },
  /**
   * SPEC-005 — no `cron`, deliberately. Both are enqueued on demand
   * (`boss.send`) by a server action under `src/app/(app)/import/` the
   * moment a user uploads a file or confirms a preview; there is no
   * schedule for "a user just did something" to fire on. AR-16 still holds:
   * the *worker* is what consumes them, and nothing about registering a
   * queue with no cron changes that only the worker ever calls
   * `boss.work`.
   */
  {
    queue: QUEUE.IMPORT_STAGE,
    handler: handleImportStage,
  },
  {
    queue: QUEUE.IMPORT_COMMIT,
    handler: handleImportCommit,
  },
  /**
   * SPEC-018 BR-018-11/DL-018-04 — no `cron`, deliberately, the same shape as
   * the two import queues above: enqueued on demand by `handleQuotesPoll`
   * (`src/worker/handlers/quotes.ts`) the moment a quote actually changes,
   * never on a schedule of its own. That is what keeps this feature's added
   * provider-request count at zero (BR-018-11's own acceptance criterion) —
   * there is no cron firing this job blind for it to matter whether the
   * handler happens to no-op.
   */
  {
    queue: QUEUE.OPPORTUNITY_EVALUATE,
    handler: handleOpportunityEvaluate,
  },
  /**
   * SPEC-009 BR-009-14/16. Both run once daily and both are ordered *after*
   * the market-data jobs above, which is the whole point of the times chosen:
   * `quotes.close-capture` (17:05), `tesouro.sync` (18:30) and `bcb.sync`
   * (19:00) are what supply the closes, the Tesouro sell prices and the day's
   * CDI. A snapshot built before them would be built from yesterday's data and
   * would then be *correct-looking but stale* — the failure mode this spec
   * exists to prevent.
   *
   * AR-18: neither cron can express a B3 holiday, so `fixedincome.accrue`
   * re-checks the trading calendar itself and `valuation.snapshot` relies on
   * carry-forward (BR-009-03) to value a non-trading day honestly.
   */
  {
    queue: QUEUE.FIXEDINCOME_ACCRUE,
    // Both handlers return a run summary, which pg-boss ignores and the
    // handler tests assert on. The wrapper is what discards it, rather than
    // widening `JobHandler` for every queue to accommodate two.
    handler: async () => {
      await handleFixedIncomeAccrue();
    },
    cron: '20 19 * * 1-5',
  },
  {
    queue: QUEUE.VALUATION_SNAPSHOT,
    handler: async () => {
      await handleValuationSnapshot();
    },
    // Daily rather than weekdays-only: a Saturday snapshot is a real chart
    // point, valued from Friday's carried-forward close (BR-009-03).
    cron: '40 19 * * *',
  },
  /**
   * SPEC-004 BR-004-09/10. Daily, and deliberately not tied to any market
   * event — deletion has nothing to do with trading hours. 03:00 is chosen
   * only to run outside the block of market-data/valuation jobs above.
   */
  {
    queue: QUEUE.ACCOUNT_DELETION_SWEEP,
    handler: async () => {
      await handleAccountDeletionSweep();
    },
    cron: '0 3 * * *',
  },
  /** SPEC-004 BR-004-15. Daily is far more often than a 1–120 month retention window needs, but cheap — a single bounded DELETE — and simplest to reason about alongside the sweep above. */
  {
    queue: QUEUE.AUDIT_RETENTION_SWEEP,
    handler: async () => {
      await handleAuditRetentionSweep();
    },
    cron: '15 3 * * *',
  },
];
