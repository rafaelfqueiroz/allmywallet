import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

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
