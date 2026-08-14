/**
 * AR-20: retry policy, backoff and dead-lettering are configured **per queue**,
 * not defaulted. A failed job must end somewhere visible (SPEC-016 BR-016-13) —
 * a job that silently vanishes after three retries is indistinguishable from
 * one that never ran.
 *
 * AR-21: payloads carry ids, not objects. They are JSON, and a `Decimal` that
 * goes through `JSON.stringify` comes back a float (AR-10).
 */
export const QUEUE = {
  QUOTES_POLL: 'quotes.poll',
  QUOTES_CLOSE_CAPTURE: 'quotes.close-capture',
  TESOURO_SYNC: 'tesouro.sync',
  BCB_SYNC: 'bcb.sync',
  IMPORT_STAGE: 'import.stage',
  IMPORT_COMMIT: 'import.commit',
  VALUATION_SNAPSHOT: 'valuation.snapshot',
  FIXEDINCOME_ACCRUE: 'fixedincome.accrue',
  BUDGET_CHECK: 'budget.check',
  // SPEC-004 BR-004-09/10: the scheduled half of self-service account
  // deletion — purges every account whose grace window has elapsed.
  ACCOUNT_DELETION_SWEEP: 'account.deletion.sweep',
  // SPEC-004 BR-004-15: audit_log retention (`retention.audit_months`).
  AUDIT_RETENTION_SWEEP: 'privacy.audit-retention.sweep',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export interface QueuePolicy {
  readonly retryLimit: number;
  readonly retryDelaySeconds: number;
  readonly retryBackoff: boolean;
  /** Where exhausted jobs land, so a failure is visible rather than lost. */
  readonly deadLetter: string;
  readonly expireInSeconds: number;
}

export const DEAD_LETTER_QUEUE = 'dead-letter';

const DEFAULT_POLICY: QueuePolicy = {
  retryLimit: 3,
  retryDelaySeconds: 30,
  retryBackoff: true,
  deadLetter: DEAD_LETTER_QUEUE,
  expireInSeconds: 300,
};

export const QUEUE_POLICIES: Readonly<Record<QueueName, QueuePolicy>> = {
  // A missed poll is corrected by the next one 30 minutes later, and the free
  // tier's 15,000 requests/month ceiling makes aggressive retrying actively
  // harmful (SPEC-008).
  [QUEUE.QUOTES_POLL]: { ...DEFAULT_POLICY, retryLimit: 2, retryDelaySeconds: 60 },
  // The close capture cannot be corrected by a later run — the close happens
  // once a day — so it retries harder.
  [QUEUE.QUOTES_CLOSE_CAPTURE]: { ...DEFAULT_POLICY, retryLimit: 5, retryDelaySeconds: 120 },
  [QUEUE.TESOURO_SYNC]: { ...DEFAULT_POLICY, retryLimit: 3, retryDelaySeconds: 300 },
  [QUEUE.BCB_SYNC]: { ...DEFAULT_POLICY, retryLimit: 3, retryDelaySeconds: 300 },
  // Parsing a 10.000-row extract is the other half of BR-005-13's 60s
  // budget and the reason AR-53 keeps it out of the web process at all — one
  // retry, generous expiry, same reasoning as IMPORT_COMMIT below.
  [QUEUE.IMPORT_STAGE]: {
    ...DEFAULT_POLICY,
    retryLimit: 1,
    retryDelaySeconds: 60,
    expireInSeconds: 1800,
  },
  // A 10,000-row commit can exceed any request timeout, which is why it is a
  // job at all. It gets an hour and one retry — a second failure is a defect,
  // not a blip, and the user is waiting for an answer either way.
  [QUEUE.IMPORT_COMMIT]: {
    ...DEFAULT_POLICY,
    retryLimit: 1,
    retryDelaySeconds: 60,
    expireInSeconds: 3600,
  },
  [QUEUE.VALUATION_SNAPSHOT]: { ...DEFAULT_POLICY, retryLimit: 3, expireInSeconds: 1800 },
  [QUEUE.FIXEDINCOME_ACCRUE]: { ...DEFAULT_POLICY, retryLimit: 3, expireInSeconds: 1800 },
  [QUEUE.BUDGET_CHECK]: { ...DEFAULT_POLICY, retryLimit: 1 },
  // Irreversible once it runs — a missed day is corrected by the next day's
  // sweep (a wider grace window than promised, never a narrower one, which
  // is the safe direction to fail in), so retries buy nothing a day later
  // wouldn't; one attempt, generous expiry for a sweep that may touch many
  // accounts.
  [QUEUE.ACCOUNT_DELETION_SWEEP]: {
    ...DEFAULT_POLICY,
    retryLimit: 1,
    expireInSeconds: 1800,
  },
  [QUEUE.AUDIT_RETENTION_SWEEP]: { ...DEFAULT_POLICY, retryLimit: 1, expireInSeconds: 1800 },
};
