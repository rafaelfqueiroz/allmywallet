import { QUEUE, type QueueName } from '@/worker/queues';
import { handleQuotesCloseCapture, handleQuotesPoll } from '@/worker/handlers/quotes';
import { handleTesouroSync } from '@/worker/handlers/tesouro';
import { handleBcbSync } from '@/worker/handlers/bcb';
import { handleBudgetCheck } from '@/worker/handlers/budget';

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
];
