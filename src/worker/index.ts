import { PgBoss, type Job, type Warning } from 'pg-boss';
import * as Sentry from '@sentry/nextjs';
import { sql } from 'drizzle-orm';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { db } from '@/db/client';
import { validateConfigOrExit } from '@/config/validate';
import { resolveConfig } from '@/config/resolve';
import { baseSentryOptions } from '@/lib/sentry';
import { raiseAlert } from '@/lib/alerts';
import { describeDeadLetterFailure, isQueueBacklogWarning } from '@/worker/alerting';
import { DEAD_LETTER_QUEUE, deadLetterCreateOptions, queueCreateOptions } from '@/worker/queues';
import { REGISTRATIONS, type JobHandler, type RegisteredWorker } from '@/worker/registrations';
import { WORKER_HEARTBEAT_ID } from '@/db/schema/observability';

/**
 * AR-48: the worker is a separate OS process from `web` (ARCHITECTURE §2) —
 * Next.js's `instrumentation.ts` never runs here, so it gets its own
 * `Sentry.init`, sharing the same scrubbing options as `sentry.server.config.ts`
 * via `baseSentryOptions` rather than duplicating them.
 */
Sentry.init({ ...baseSentryOptions(env().SENTRY_DSN), tracesSampleRate: 0.1 });

/**
 * The worker is a second entrypoint into the same image, not a separate service
 * (ARCHITECTURE §2). It exists because two things genuinely do not fit inside a
 * request/response cycle: SPEC-008 polls quotes on a schedule through market
 * hours, and SPEC-005 commits 10,000-row imports.
 *
 * AR-16: **only the worker registers schedules.** The web process may enqueue,
 * never schedule or consume — that keeps cron ownership in exactly one place.
 *
 * The registration list itself — `REGISTRATIONS`, `JobHandler`,
 * `RegisteredWorker` — lives in `./registrations.ts` and is re-exported here
 * unchanged, so this file's public surface is exactly what it was before.
 */
export { REGISTRATIONS, type JobHandler, type RegisteredWorker };

export async function startWorker(): Promise<PgBoss> {
  // AR-41: both entrypoints validate on boot. SPEC-002 BR-002-04 — an invalid
  // value must fail the worker's boot loudly, the same as it does web's
  // (src/instrumentation.ts). A bad value must not start half the system.
  await validateConfigOrExit(db);

  const boss = new PgBoss({
    connectionString: env().DATABASE_URL,
    schema: 'pgboss',
    /**
     * `0006_pgboss_schema.sql` already creates the `pgboss` schema, as the
     * migrator, and grants `USAGE, CREATE` on it to `allmywallet_app` so
     * pg-boss can still build its own tables inside.
     *
     * Without this flag pg-boss issues `CREATE SCHEMA IF NOT EXISTS pgboss`
     * on every start, and PostgreSQL checks `CREATE` **on the database**
     * before the `IF NOT EXISTS` short-circuits. `allmywallet_app` is
     * `NOCREATEDB` and holds no database-level `CREATE` by design (AR: the
     * runtime role is not the table owner), so the statement fails 42501 and
     * the worker exits before consuming a single job — with the schema sitting
     * right there, already correct.
     */
    createSchema: false,
  });

  boss.on('error', (error: unknown) => {
    logger.error({ err: error }, 'pg-boss error');
  });

  // SPEC-016 BR-016-13/BR-016-14: the backlog threshold is config, not code —
  // read once at boot and handed to every `createQueue` call below as
  // `warningQueueSize`. pg-boss re-evaluates each queue's `queuedCount`
  // against it on its own maintenance cycle and emits a `warning` event; the
  // listener below is what turns that into an operator-visible alert.
  const backlogThreshold = (await resolveConfig('alerts.queue_backlog_threshold', { db })).value;

  boss.on('warning', (warning: Warning) => {
    const backlog = isQueueBacklogWarning(warning.data);
    if (!backlog) return; // slow-query / clock-skew warning — not this alert's concern
    raiseAlert('queue_backlog', { ...backlog, threshold: backlogThreshold });
  });

  // AR-50: the `/api/health` "worker liveness" component reads this back
  // (src/lib/health.ts#checkWorkerLiveness). pg-boss has no built-in signal
  // for "the process is alive" — only active job leases, silent when the
  // queue is idle — so the worker writes its own on a config-driven cadence.
  const heartbeatIntervalSeconds = (
    await resolveConfig('observability.worker_heartbeat_interval_seconds', { db })
  ).value;

  async function writeHeartbeat(): Promise<void> {
    await db.execute(sql`
      INSERT INTO worker_heartbeats (id, updated_at) VALUES (${WORKER_HEARTBEAT_ID}, now())
      ON CONFLICT (id) DO UPDATE SET updated_at = now()
    `);
  }

  // Written once immediately, so a heartbeat exists from the first health
  // check rather than only after the first interval tick.
  await writeHeartbeat();
  setInterval(() => {
    writeHeartbeat().catch((error: unknown) => {
      logger.error({ err: error }, 'failed to write worker heartbeat');
    });
  }, heartbeatIntervalSeconds * 1000);

  await boss.start();
  await boss.createQueue(DEAD_LETTER_QUEUE, deadLetterCreateOptions(backlogThreshold));

  // AR-20/BR-016-13: every queue below names DEAD_LETTER_QUEUE as its
  // `deadLetter` (queues.ts), so a job that exhausts its retries always lands
  // here. This is the one place "a failed job must end somewhere visible"
  // becomes actually true rather than aspirational — nobody has to remember
  // to check a table, because landing here raises an alert immediately.
  // BR-016-11's "market-data job failures alert operators" is satisfied by
  // the same mechanism: SPEC-008's quote/index-sync queues share this exact
  // dead-letter path once #11 registers their handlers, with no additional
  // alerting code needed on that spec's side.
  await boss.work(DEAD_LETTER_QUEUE, async (jobs: Job<object>[]) => {
    for (const job of jobs) {
      // `Job<T>` (handed to `work()`) does not carry `sourceName` — only
      // `JobWithMetadata` does — so the originating queue is looked up
      // explicitly rather than left unknown in the alert.
      const original = await boss.getJobById(DEAD_LETTER_QUEUE, job.id);
      raiseAlert('job_failed', describeDeadLetterFailure(job, original));
    }
  });

  for (const registration of REGISTRATIONS) {
    await boss.createQueue(
      registration.queue,
      queueCreateOptions(registration.queue, backlogThreshold),
    );

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
