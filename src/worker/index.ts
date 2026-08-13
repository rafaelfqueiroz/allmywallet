import { PgBoss, type Job } from 'pg-boss';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { db } from '@/db/client';
import { validateConfigOrExit } from '@/config/validate';
import { DEAD_LETTER_QUEUE, QUEUE_POLICIES, type QueueName } from '@/worker/queues';

/**
 * The worker is a second entrypoint into the same image, not a separate service
 * (ARCHITECTURE §2). It exists because two things genuinely do not fit inside a
 * request/response cycle: SPEC-008 polls quotes on a schedule through market
 * hours, and SPEC-005 commits 10,000-row imports.
 *
 * AR-16: **only the worker registers schedules.** The web process may enqueue,
 * never schedule or consume — that keeps cron ownership in exactly one place.
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
 */
const REGISTRATIONS: readonly RegisteredWorker[] = [];

export async function startWorker(): Promise<PgBoss> {
  // AR-41: both entrypoints validate on boot. SPEC-002 BR-002-04 — an invalid
  // value must fail the worker's boot loudly, the same as it does web's
  // (src/app/instrumentation.ts). A bad value must not start half the system.
  await validateConfigOrExit(db);

  const boss = new PgBoss({
    connectionString: env().DATABASE_URL,
    schema: 'pgboss',
  });

  boss.on('error', (error: unknown) => {
    logger.error({ err: error }, 'pg-boss error');
  });

  await boss.start();
  await boss.createQueue(DEAD_LETTER_QUEUE);

  for (const registration of REGISTRATIONS) {
    const policy = QUEUE_POLICIES[registration.queue];
    await boss.createQueue(registration.queue, {
      retryLimit: policy.retryLimit,
      retryDelay: policy.retryDelaySeconds,
      retryBackoff: policy.retryBackoff,
      deadLetter: policy.deadLetter,
      expireInSeconds: policy.expireInSeconds,
    });

    await boss.work(registration.queue, async ([job]: Job<object>[]) => {
      if (!job) return;
      // AR-19: handlers are idempotent. pg-boss retries, and a retried quote
      // poll or accrual must not double-apply.
      await (registration.handler as JobHandler<object>)(job.data as object);
    });

    if (registration.cron) {
      // AR-17: getting the timezone wrong silently shifts every poll by three
      // hours, which looks like a provider outage rather than a bug.
      await boss.schedule(registration.queue, registration.cron, undefined, {
        tz: 'America/Sao_Paulo',
      });
    }
  }

  logger.info({ queues: REGISTRATIONS.length }, 'worker started');
  return boss;
}

async function main(): Promise<void> {
  const boss = await startWorker();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'worker shutting down');
    await boss.stop({ graceful: true });
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Only run when invoked directly, so tests can import `startWorker` without
// spawning a live consumer.
if (process.argv[1]?.includes('worker')) {
  main().catch((error: unknown) => {
    logger.error({ err: error }, 'worker failed to start');
    process.exit(1);
  });
}
