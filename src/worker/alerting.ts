/**
 * SPEC-016 BR-016-13/BR-016-14: the pure decision logic behind `startWorker`'s
 * alert wiring (`src/worker/index.ts`), split out so it is testable without a
 * live pg-boss/Postgres instance (TS-01) — `startWorker` itself is excluded
 * from the coverage gate (vitest.config.ts) precisely because framework
 * wiring like `boss.on(...)` is not, but the decisions made *inside* those
 * callbacks are ordinary logic and belong under test like anything else.
 */

export interface QueueBacklogWarning {
  readonly queue: string;
  readonly queuedCount: number;
}

/**
 * pg-boss emits `warning` for queue backlogs, slow queries and clock skew
 * alike, all through the same event, typed only as `data: object` — this is
 * what tells them apart. Only a queue-backlog warning carries both `name`
 * (the queue) and a numeric `queuedCount`; matching on message text instead
 * would break silently if pg-boss ever reworded it. `unknown` plus a runtime
 * check (DV-02) rather than trusting the loose `object` type pg-boss gives it.
 */
export function isQueueBacklogWarning(data: object): QueueBacklogWarning | undefined {
  const record = data as Record<string, unknown>;
  const queue = record.name;
  const queuedCount = record.queuedCount;
  if (typeof queue !== 'string' || typeof queuedCount !== 'number') return undefined;
  return { queue, queuedCount };
}

export interface DeadLetterJob {
  readonly id: string;
}

export interface DeadLetterSource {
  readonly sourceName: string | null;
}

/**
 * AR-21's "payloads carry ids, not objects" is what makes it safe to log this
 * unconditionally — a dead-lettered job's `data` never carries anything
 * beyond ids and small structural facts, so this never needs to inspect (or
 * risk logging) the payload itself.
 */
export function describeDeadLetterFailure(
  job: DeadLetterJob,
  original: DeadLetterSource | null,
): { readonly jobId: string; readonly originalQueue: string } {
  return { jobId: job.id, originalQueue: original?.sourceName ?? 'unknown' };
}
