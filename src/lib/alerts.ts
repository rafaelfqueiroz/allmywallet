import * as Sentry from '@sentry/nextjs';
import { childLogger } from '@/lib/logger';

/**
 * SPEC-016 BR-016-13: "operational alerting covers at minimum: market-data job
 * failure, provider budget threshold, background job backlog, error rate, and
 * failed backup." This is the single place an operator-visible alert is
 * raised, so every caller produces the same shape and a future alerting
 * channel (email, Slack, PagerDuty — none is chosen yet, Out of Scope for this
 * spec beyond "reaches an operator") only has to be wired here once.
 *
 * At M0 there is no dedicated alerting channel — Sentry (already required by
 * AR-48) *is* the operator-visible surface: every alert is a Sentry event at
 * `error` level, tagged so it is filterable from an ordinary exception, plus a
 * structured log line for anything shipping logs to a second destination
 * (Loki, per ARCHITECTURE §12's M4 phase-in). This is deliberately not a
 * silent no-op: `Sentry.captureMessage` still reaches an operator today
 * through the Sentry project's own notification rules, which is what makes
 * "each alert fires and reaches an operator" (SPEC-016 AC) checkable now
 * rather than only after a dedicated channel exists.
 */
export type AlertKind =
  /** SPEC-008 BR-008-27 / BR-016-11: a market-data job exhausted its retries. */
  | 'market_data_job_failure'
  /** SPEC-008: the monthly quote-provider budget crossed its alert threshold. */
  | 'provider_budget_threshold'
  /** AR-20: any job — market-data or otherwise — landed in the dead-letter queue. */
  | 'job_failed'
  /** The dead-letter queue itself has grown past its configured threshold. */
  | 'queue_backlog'
  /** Deferred to M4 (ARCHITECTURE §12) — no metrics pipeline exists yet to compute a rate from. */
  | 'error_rate'
  /** BR-016-09/AR-64 — deferred to BL-001 (#1). Declared here so the eventual implementation has nowhere else to invent a shape. */
  | 'backup_failed';

export interface AlertContext {
  readonly [key: string]: string | number | boolean | null;
}

const alertLogger = childLogger({ component: 'alerts' });

/**
 * AR-39/AR-49: context is restricted to primitives for the same reason
 * `DomainError`'s is — it makes it awkward to drop personal data into
 * something that is about to be logged and sent to Sentry. Callers pass
 * structural facts (a queue name, a count, a threshold), never an entity.
 */
export function raiseAlert(kind: AlertKind, context: AlertContext = {}): void {
  alertLogger.error({ alertKind: kind, ...context }, `operational alert: ${kind}`);
  Sentry.captureMessage(`operational alert: ${kind}`, {
    level: 'error',
    tags: { alertKind: kind },
    extra: context,
  });
}
