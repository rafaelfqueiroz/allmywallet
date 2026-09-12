import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId, ImportBatchId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
import type { ReportQueryResult } from '@/core/reporting/base-query';
import type { ImportRowAttentionCount } from '@/core/ingestion/ports';
import type { ReconciliationReport } from '@/core/ingestion/reconcile';
import { daysSinceImport, isImportStale } from '@/core/ingestion/staleness';
import type { PendingAllocation } from '@/core/wallets/pending';

/**
 * **The authenticated landing screen** — the one #98 exists to create, because
 * three rules in closed specs require it and had nowhere to live:
 * SPEC-005 BR-005-26 (reconciliation status), SPEC-010 BR-010-12 (purchases
 * awaiting allocation) and SPEC-016 BR-016-02 / FR-8.29 (a 2s p95 budget on a
 * screen that did not exist). SPEC-001 BR-001-04's "routes to onboarding" was
 * unmet for the same reason.
 *
 * **Nothing here computes a figure.** Every number on this screen has already
 * been computed somewhere else and is being *re-presented*:
 *
 *  - the portfolio total is `ReportQueryResult.report.total.value` — the same
 *    fold over the same valued holdings that SPEC-013's headline and SPEC-015's
 *    scope total read, produced by the same call to `runReportQuery`. It is not
 *    a second opinion about the same money, which is the only arrangement under
 *    which the dashboard and the Patrimônio report cannot disagree (BR-013-12);
 *  - the reconciliation report is what `reconcile.ts` computed at commit time
 *    and `import_batches.reconciliation` persisted;
 *  - the pending allocations are `listPendingAllocations`' own output;
 *  - staleness is `core/ingestion/staleness.ts`, resolved against the user's
 *    own `import.staleness_days`.
 *
 * That is deliberate rather than lazy. A dashboard is exactly where somebody
 * would be tempted to recompute "just the headline" from the ledger, and
 * SPEC-016 BR-016-05 forbids it — `tests/structural/reports-read-snapshots.ts`
 * scans this directory under the same absolute rule it applies to
 * `core/reporting/`.
 *
 * Pure and framework-free (AR-01): every input arrives from the loader
 * (`src/app/(app)/dashboard/data.ts`), which gathers them inside **one**
 * `withTenant` transaction so the value, the queue and the reconciliation
 * status all describe one consistent view of the tenant's data.
 */

// ---------------------------------------------------------------------------
// Portfolio value (BR-020-27, BR-011-16)
// ---------------------------------------------------------------------------

/**
 * SPEC-020 BR-020-27 — "before the first import the dashboard shows an explicit
 * onboarding empty state, **not zeros**. A portfolio displayed as R$ 0,00 is a
 * false claim; an empty state is the truth."
 *
 * **Two empties, not one**, and the distinction is the whole reason this is a
 * union rather than a nullable `Money`:
 *
 *  - `onboarding` — nothing is held and nothing was ever imported. This is the
 *    first-run user, and the honest sentence is "there is nothing here yet;
 *    here is how to bring your data in".
 *  - `no_holdings` — nothing is held, but custody data *has* been imported.
 *    Telling this user to import their extract would be telling them to do
 *    something they have already done; their portfolio is genuinely empty
 *    today, which is a different fact and a different sentence.
 *
 * Collapsing the two would have been simpler and would have lied to one of
 * them. Neither renders a figure: BR-020-27 forbids the zero in both cases,
 * because "you hold nothing" and "we have nothing" look identical as R$ 0,00.
 */
export type DashboardPortfolio =
  | { readonly kind: 'onboarding' }
  | { readonly kind: 'no_holdings' }
  | {
      readonly kind: 'valued';
      /** BR-013-12 — the same total the Patrimônio and Composição reports show. */
      readonly value: Money;
      /**
       * BR-011-15 / CR-1 — `true` when any component of the total is computed
       * rather than observed: accrued fixed income, or a holding that fell back
       * to cost because nothing could price it. One is enough to mark the
       * figure, because the user is owed the caveat about the number they are
       * actually reading.
       */
      readonly estimated: boolean;
    };

/**
 * SPEC-008 BR-008-04, SPEC-005 BR-005-27/28, SPEC-013 BR-013-13 — the four
 * questions a figure on this screen has to be able to answer about itself.
 *
 * Kept outside `DashboardPortfolio` because they are facts about the *request*,
 * not about the money: a first-run user with no holdings still has a valuation
 * date and still has never imported, and both are worth saying.
 */
export interface DashboardFreshness {
  /** The date the figures are valued at. */
  readonly valuationAsOf: BusinessDate;
  /**
   * BR-008-04 — the provider's own as-of **instant** for the freshest quote
   * behind these holdings. An instant, not a date: a ~30-minute delay is
   * invisible at date resolution, and making it visible is this field's only
   * job. `null` when nothing held is priced by a live quote, the ordinary case
   * for a fixed-income-only portfolio.
   */
  readonly quotedAt: Date | null;
  /** BR-008-04's delay tier, in plain minutes — the resolved `quotes.cadence_minutes`. */
  readonly delayMinutes: number;
  /** BR-005-27 — when custody data was last imported. `null` before the first import. */
  readonly lastImportAt: BusinessDate | null;
  /** `null` when there has never been an import — "never" is not a number of days. */
  readonly daysSinceImport: number | null;
  /** The resolved `import.staleness_days`; a user-level key, so this is their number, not the deployment's. */
  readonly thresholdDays: number;
  /** BR-005-28. Always `true` before the first import — see `staleness.ts` on why "never" is the strongest case, not the weakest. */
  readonly stale: boolean;
}

// ---------------------------------------------------------------------------
// Reconciliation status (BR-005-26)
// ---------------------------------------------------------------------------

/**
 * BR-005-26 — "portfolio reconciliation status (`reconciled` /
 * `discrepancies found` / `never reconciled`) is visible on the dashboard".
 *
 * Three states, where `reconcile.ts` persists only two: `never_reconciled` is
 * not a value any import ever wrote, it is the absence of one, and the rule
 * names it explicitly because "we have never checked" and "we checked and it
 * agreed" are opposite assurances that would otherwise render identically.
 */
export const DASHBOARD_RECONCILIATION_STATES = [
  'reconciled',
  'discrepancies_found',
  'never_reconciled',
] as const;
export type DashboardReconciliationState = (typeof DASHBOARD_RECONCILIATION_STATES)[number];

/** The most recent committed Posição batch that carries a reconciliation report. */
export interface ReconciliationSource {
  readonly batchId: ImportBatchId;
  readonly report: ReconciliationReport;
}

export interface DashboardReconciliation {
  readonly state: DashboardReconciliationState;
  /** BR-005-22 — the Posição date the comparison was made against. `null` when never reconciled. */
  readonly asOf: BusinessDate | null;
  /** Discrepancies the user has not yet accepted as an adjustment. Zero in the other two states. */
  readonly unresolvedCount: number;
  /** The batch to open to see them (BR-005-23). `null` when never reconciled. */
  readonly batchId: ImportBatchId | null;
}

/**
 * **The stored `status` is deliberately not read here, and that is a bug fix,
 * not a shortcut.**
 *
 * `reconcile.ts` sets `status` once, at commit, from what the comparison found.
 * BR-005-25 then lets the user accept B3's figure for a discrepancy, and
 * `accept-adjustment.ts` marks that discrepancy `resolved: true` — but leaves
 * `status` exactly as it was. That is correct of the *batch*: the import really
 * did find a disagreement, and rewriting its record afterwards would erase what
 * happened.
 *
 * It is wrong of the **dashboard**, which is answering a question about now.
 * A user who has resolved every discrepancy has a reconciled portfolio, and a
 * permanent "discrepâncias encontradas" badge on the landing screen — with
 * nothing left behind it to act on — trains them to ignore the one indicator
 * that is supposed to mean something.
 *
 * So the state is derived from the `resolved` flags, and `unresolvedCount` is
 * what it is derived from. The batch's own record is untouched.
 */
export function reconciliationStatus(source: ReconciliationSource | null): DashboardReconciliation {
  if (source === null) {
    return { state: 'never_reconciled', asOf: null, unresolvedCount: 0, batchId: null };
  }
  const unresolvedCount = source.report.discrepancies.filter(
    (discrepancy) => !discrepancy.resolved,
  ).length;
  return {
    state: unresolvedCount === 0 ? 'reconciled' : 'discrepancies_found',
    asOf: source.report.asOf,
    unresolvedCount,
    batchId: source.batchId,
  };
}

// ---------------------------------------------------------------------------
// "Needs attention" (BR-010-12)
// ---------------------------------------------------------------------------

/**
 * SPEC-010 BR-010-12 — "purchases awaiting allocation appear in the same
 * 'Needs attention' queue used for unclassified imports, and on the
 * post-import summary **and dashboard** until resolved."
 *
 * One queue with two kinds of member rather than two lists, for the reason
 * SPEC-017 DL-017-08 already gave when it put out-of-balance wallets here
 * instead of building a second panel: BR-010-12 established *one* place to look
 * for "is there anything for me to do?", and a second surface splits the answer
 * across two screens.
 */
export type AttentionItem =
  | {
      /**
       * Rows a committed import left needing a decision — `unclassified` or
       * `invalid`, the pair `/import/[batchId]` already calls "needs
       * attention". Counted per batch so the entry links to the one screen
       * that resolves it (SPEC-020 BR-020-18's shape, met here by the queue
       * that already existed).
       */
      readonly kind: 'import_rows';
      readonly batchId: ImportBatchId;
      readonly count: number;
    }
  | {
      readonly kind: 'pending_allocation';
      readonly assetId: AssetId;
      /**
       * From the holding set this same query produced — a pending allocation is
       * by definition an asset the tenant holds, so the lookup hits. `null` is
       * carried rather than asserted because the alternative to a missing label
       * is throwing away a real item the user needs to see; the UI names the
       * queue entry generically instead of vanishing it.
       */
      readonly assetCode: string | null;
      readonly quantity: Quantity;
      readonly reason: PendingAllocation['reason'];
    };

export interface AssetLabel {
  readonly code: string;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// The assembled summary
// ---------------------------------------------------------------------------

export interface DashboardSummary {
  readonly portfolio: DashboardPortfolio;
  readonly freshness: DashboardFreshness;
  readonly reconciliation: DashboardReconciliation;
  readonly attention: readonly AttentionItem[];
}

export interface DashboardSummaryInput {
  /**
   * `runReportQuery` at **portfolio** scope, run by the loader. Passing the
   * whole result rather than a pre-extracted total is what keeps this screen's
   * headline the report's own figure instead of a number that merely ought to
   * match it.
   */
  readonly query: ReportQueryResult;
  readonly quotedAt: Date | null;
  readonly delayMinutes: number;
  readonly lastImportAt: BusinessDate | null;
  readonly thresholdDays: number;
  /** `Clock.today()`, passed in and never read ambiently (AR-03, AR-29). */
  readonly today: BusinessDate;
  readonly reconciliation: ReconciliationSource | null;
  readonly pending: readonly PendingAllocation[];
  readonly unclassified: readonly ImportRowAttentionCount[];
  /** Asset code and name for the queue's labels, keyed by id. */
  readonly assetLabels: ReadonlyMap<AssetId, AssetLabel>;
}

/**
 * BR-010-12's queue, assembled.
 *
 * **Unclassified rows lead, and the order is an argument rather than a
 * preference.** A row left `unclassified` is stored and inert everywhere else
 * (SPEC-006 DL-006-06): it is excluded from the replay that produced the
 * positions, so it makes *every figure on this screen* understated, including
 * the headline directly above the queue. A holding awaiting allocation is
 * already inside that total and is only missing a filing decision — nothing on
 * the screen is wrong because of it. So the item that changes the numbers is
 * listed before the item that does not.
 *
 * Zero-count batches are dropped rather than rendered as "0 linhas": an empty
 * queue must be able to mean "nothing to do", and a row saying there is nothing
 * to do in it is the same noise the queue exists to remove.
 */
function attentionQueue(input: DashboardSummaryInput): readonly AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const batch of input.unclassified) {
    if (batch.count <= 0) continue;
    items.push({ kind: 'import_rows', batchId: batch.batchId, count: batch.count });
  }

  for (const pending of input.pending) {
    items.push({
      kind: 'pending_allocation',
      assetId: pending.assetId,
      assetCode: input.assetLabels.get(pending.assetId)?.code ?? null,
      quantity: pending.unassignedQuantity,
      reason: pending.reason,
    });
  }

  return items;
}

/**
 * BR-020-27 / BR-011-16 — the figure, or the honest absence of one.
 *
 * `query.empty` is SPEC-011's own `isEmptyScope`: the scope holds nothing. It
 * is the right test rather than `value.isZero()`, because a portfolio *can*
 * hold positions that currently price to zero, and those are a figure — an
 * empty state would be a false claim in the other direction.
 */
function portfolioOf(input: DashboardSummaryInput): DashboardPortfolio {
  if (!input.query.empty) {
    return {
      kind: 'valued',
      value: input.query.report.total.value,
      estimated: input.query.report.total.estimated,
    };
  }
  return input.lastImportAt === null ? { kind: 'onboarding' } : { kind: 'no_holdings' };
}

export function buildDashboardSummary(input: DashboardSummaryInput): DashboardSummary {
  return {
    portfolio: portfolioOf(input),
    freshness: {
      valuationAsOf: input.query.asOf,
      quotedAt: input.quotedAt,
      delayMinutes: input.delayMinutes,
      lastImportAt: input.lastImportAt,
      daysSinceImport: daysSinceImport(input.lastImportAt, input.today),
      thresholdDays: input.thresholdDays,
      stale: isImportStale({
        lastImportAt: input.lastImportAt,
        today: input.today,
        thresholdDays: input.thresholdDays,
      }),
    },
    reconciliation: reconciliationStatus(input.reconciliation),
    attention: attentionQueue(input),
  };
}
