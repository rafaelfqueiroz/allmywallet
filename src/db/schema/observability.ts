import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * SPEC-016 AR-50: `/api/health` reports "worker liveness" as one of its three
 * independent components. pg-boss has no built-in "the worker process is
 * alive" signal — only active job leases, which say nothing when the queue is
 * simply idle — so the worker writes its own heartbeat here on a config-driven
 * interval (`observability.worker_heartbeat_interval_seconds`), and the
 * health check considers it live when the row is newer than
 * `observability.worker_heartbeat_stale_seconds`.
 *
 * Singleton row (`id = 'worker'`) rather than one per process: there is
 * exactly one worker container per ARCHITECTURE §2's topology, and scaling to
 * several would need a design for *which* one health reports on anyway — not
 * a problem to half-solve here.
 *
 * Holds no personal data — a process identity string and a timestamp — so it
 * is declared exempt in `src/db/shared-tables.ts` alongside `runtime_state`,
 * on the same AR-15/BR-003-06 test ("holds no personal data"), not because it
 * is reference data.
 */
export const workerHeartbeats = pgTable('worker_heartbeats', {
  id: text('id').primaryKey(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The only row this table ever holds (see the singleton-row note above). */
export const WORKER_HEARTBEAT_ID = 'worker';

/**
 * SPEC-021 BR-021-20: a failed backup is never silent. `scripts/personal/backup.sh`
 * records every outcome here through `dist/ops.js backup-record`, and both
 * `/api/health`'s `backup` component and the in-app notice read the newest row
 * — so a failure stays visible until a later run succeeds, and no longer.
 *
 * Append-only history rather than a singleton like `worker_heartbeats`: "the
 * last success was nine days ago" is what the notice has to say, and a single
 * overwritten row would have forgotten it at the first failure.
 *
 * Holds no personal data — see its `SHARED_TABLES` entry.
 */
export const backupRuns = pgTable(
  'backup_runs',
  {
    id: uuid('id').primaryKey(),
    status: text('status').notNull(),
    /** The dump's file name on success; never a path into the user's home directory. */
    fileName: text('file_name'),
    /** Why it failed, as the script reported it. */
    detail: text('detail'),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('backup_runs_status_check', sql`${table.status} IN ('succeeded', 'failed')`),
    index('backup_runs_finished_at_idx').on(table.finishedAt),
  ],
);
