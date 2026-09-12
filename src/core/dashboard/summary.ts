import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId, ImportBatchId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
import type { ReportQueryResult } from '@/core/reporting/base-query';
import type { ReportHolding } from '@/core/reporting/ports';
import type { ImportRowAttentionCount } from '@/core/ingestion/ports';
import type { ReconciliationReport } from '@/core/ingestion/reconcile';
import { daysSinceImport, isImportStale } from '@/core/ingestion/staleness';
import type { ContractMissingRate } from '@/core/onboarding/ports';
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
      readonly markers: ValuationMarkers;
    };

/**
 * SPEC-009 AC-3/AC-9/AC-11 — **how this total was priced**, at portfolio grain.
 *
 * `HoldingMarkers` (`app/(app)/reports/_components/`) already makes this
 * argument per row, and its header records the defect that produced it: the
 * engine distinguishes three different things and the screen collapsed them
 * into one "Estimado" badge. The dashboard shows a single number over an entire
 * portfolio, which is the place that collapse costs the most — one caveat
 * covering every holding has to be the *right* caveat, because there is no row
 * beneath it to look at.
 *
 *  - `unpriced` (BR-009-13) — nothing could price these holdings, so they sit
 *    at acquisition cost. The figure is not a valuation at all for that part,
 *    and this is the only one of the three that asks the user to act.
 *  - `accrued` (BR-009-11) — computed from a contracted indexer rather than
 *    observed. A real figure, just not a market one.
 *  - `carriedForward` (BR-009-03 / BR-008-24) — a real observed close, from an
 *    earlier date. A weekend, a holiday, a trading halt — or, on the free quote
 *    tier, a poll the budget could not afford (PRD R5). Deliberately not folded
 *    into `accrued`: doing so would mark every Saturday's whole portfolio an
 *    estimate and drain the word of meaning. Deliberately not *dropped* either,
 *    which is what BR-008-24 forbids — "never shown as current when it is not".
 */
export interface ValuationMarkers {
  /** BR-011-15 / CR-1 — any component computed rather than observed. `accrued || unpriced > 0`. */
  readonly estimated: boolean;
  readonly accrued: boolean;
  /**
   * How many **positions** nothing could price. Zero is the ordinary case.
   *
   * Positions, not holdings, and the distinction is the whole reason this is a
   * fold rather than a filter's `length`. `buildHoldingSet` emits one
   * `ReportHolding` per *wallet slice* of a position — every allocation plus the
   * unallocated remainder — and copies `needsAttention` onto each slice
   * unchanged, deliberately ("value and quantity divide between wallets; how
   * the price was obtained does not"). So one unpriceable CDB filed across
   * three carteiras is three holdings, and counting holdings told the user
   * *"3 posições não puderam ser precificadas"* about a single position — with
   * no row beneath the badge to reconcile it against, which is exactly the
   * situation `ValuationMarkers` exists to handle honestly.
   *
   * Counted at `(asset, institution)`, which is SPEC-007 BR-007-08's position
   * grain and therefore the unit the user can go and look at.
   */
  readonly unpriced: number;
  readonly carriedForward: boolean;
  /**
   * The **oldest** price date behind the total, across the holdings priced from
   * an earlier close. The oldest rather than the newest, because `quotedAt`
   * below is already the high-water mark and a screen carrying only that is the
   * one BR-008-24 describes: a *patrimônio* three weeks behind the market under
   * a line saying the quotes are half an hour old. `null` when nothing is
   * carried forward.
   */
  readonly oldestPriceDate: BusinessDate | null;
}

/** SPEC-009's three facts, folded over the scoped holdings. */
export function valuationMarkers(holdings: readonly MarkedHolding[]): ValuationMarkers {
  let accrued = false;
  let oldestPriceDate: BusinessDate | null = null;
  const unpricedPositions = new Set<string>();

  for (const holding of holdings) {
    // `basis` is the accrual's own evidence (indexer, rate, business days), so
    // its presence is what separates "computed from a contract" from "fell back
    // to cost" — the two causes of `estimated` that a single flag cannot tell
    // apart. `HoldingMarkers` makes the same test per row.
    if (holding.estimated && holding.basis !== null) accrued = true;
    if (holding.needsAttention !== null) {
      // De-duplicated across wallet slices — see `unpriced`'s own note.
      unpricedPositions.add(`${holding.assetId}|${holding.institutionId ?? ''}`);
    }
    if (holding.carriedForward && holding.priceDate !== null) {
      if (oldestPriceDate === null || holding.priceDate < oldestPriceDate) {
        oldestPriceDate = holding.priceDate;
      }
    }
  }

  return {
    estimated: accrued || unpricedPositions.size > 0,
    accrued,
    unpriced: unpricedPositions.size,
    carriedForward: oldestPriceDate !== null,
    oldestPriceDate,
  };
}

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
  /**
   * Discrepancies the user **has** accepted (BR-005-25). Carried because
   * `reconciled` has two histories behind it and they are not the same
   * assurance: the comparison found nothing, or it found disagreements the user
   * has since settled. Saying "todas as quantidades bateram" to the second user
   * asserts something that did not happen.
   */
  readonly resolvedCount: number;
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
    return {
      state: 'never_reconciled',
      asOf: null,
      unresolvedCount: 0,
      resolvedCount: 0,
      batchId: null,
    };
  }
  const unresolvedCount = source.report.discrepancies.filter(
    (discrepancy) => !discrepancy.resolved,
  ).length;
  return {
    state: unresolvedCount === 0 ? 'reconciled' : 'discrepancies_found',
    asOf: source.report.asOf,
    unresolvedCount,
    resolvedCount: source.report.discrepancies.length - unresolvedCount,
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
      /**
       * SPEC-020 BR-020-16/19 — a held fixed-income contract whose indexer or
       * rate could not be read. Valued at cost (SPEC-009 BR-009-13), so the
       * headline above is understated until the user supplies it.
       */
      readonly kind: 'fixed_income_rate';
      readonly assetId: AssetId;
      readonly assetCode: string | null;
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

/**
 * The slice of `ReportHolding` the markers fold reads. Narrowed rather than
 * taking the whole type so the fold states exactly what it depends on — and so
 * a test can build one without inventing a value, a wallet and a sector that
 * have nothing to do with how the holding was priced.
 */
export type MarkedHolding = Pick<
  ReportHolding,
  | 'assetId'
  | 'institutionId'
  | 'estimated'
  | 'basis'
  | 'carriedForward'
  | 'priceDate'
  | 'needsAttention'
>;

// ---------------------------------------------------------------------------
// The assembled summary
// ---------------------------------------------------------------------------

export interface DashboardSummary {
  readonly portfolio: DashboardPortfolio;
  readonly freshness: DashboardFreshness;
  readonly reconciliation: DashboardReconciliation;
  /** At most `ATTENTION_QUEUE_LIMIT` items — see `attentionQueue`. */
  readonly attention: readonly AttentionItem[];
  /**
   * How many items there are in all, so the screen can say what it is **not**
   * showing rather than silently truncating. A queue that hides work without
   * admitting it is worse than a long one.
   */
  readonly attentionTotal: number;
}

/**
 * How many queue items the dashboard shows before deferring to `/wallets`.
 *
 * **A cap is necessary here and nowhere else**, because the ordinary first-week
 * state produces one item per held asset: a user who has imported a full
 * extract and not yet created a wallet has every holding awaiting allocation.
 * At BR-016-01's reference scale that is a hundred rows under the headline,
 * which turns "is there anything for me to do?" into a holdings list and pushes
 * the reconciliation status off the first screenful. The nightly budget cannot
 * see it, because it measures the loader rather than the render.
 *
 * Five, because the queue's job on this screen is to answer *whether* there is
 * work and of *what kind* — `/wallets` is where it is done, and it shows the
 * whole list with the forms to resolve each one.
 */
export const ATTENTION_QUEUE_LIMIT = 5;

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
  /** The first date this tenant has a valuation snapshot for; `null` before any. */
  readonly earliestSnapshot: BusinessDate | null;
  /**
   * BR-020-26 — whether the position cache holds a row for this tenant at all,
   * **including one closed to zero**. The trace a manual-entry user leaves after
   * selling everything, and the reason the onboarding empty state is not keyed
   * on imports alone. SPEC-007's cache, never the ledger (BR-016-05).
   */
  readonly hasEverHeldAnything: boolean;
  readonly thresholdDays: number;
  /** `Clock.today()`, passed in and never read ambiently (AR-03, AR-29). */
  readonly today: BusinessDate;
  readonly reconciliation: ReconciliationSource | null;
  readonly pending: readonly PendingAllocation[];
  readonly unclassified: readonly ImportRowAttentionCount[];
  /**
   * SPEC-020 BR-020-16/19 — held fixed-income contracts with no readable
   * indexer or rate. `core/onboarding`'s own read (BR-020-07's query), passed
   * in rather than re-derived here, for the same reason `unclassified` and
   * `pending` are: this module assembles a queue, it does not compute one.
   */
  readonly contractsMissingRate: readonly ContractMissingRate[];
  /** Asset code and name for the queue's labels, keyed by id. */
  readonly assetLabels: ReadonlyMap<AssetId, AssetLabel>;
}

/**
 * BR-010-12's queue, assembled.
 *
 * **Unclassified rows and unpriced fixed-income contracts lead, in that
 * order, and the order is an argument rather than a preference.** Both
 * understate the headline directly above the queue: a row left
 * `unclassified` is stored and inert everywhere else (SPEC-006 DL-006-06),
 * excluded from the replay that produced the positions, and a contract with
 * no readable rate cannot be accrued (SPEC-009 BR-009-13) and sits at cost
 * instead (SPEC-020 BR-020-19). A holding awaiting allocation is already
 * inside that total and is only missing a filing decision — nothing on the
 * screen is wrong because of it. So the two kinds that change the numbers are
 * listed before the kind that does not; between the two, unclassified rows
 * lead because they are what SPEC-005 already surfaced first, on
 * `/import/[batchId]`.
 *
 * Zero-count batches are dropped rather than rendered as "0 linhas": an empty
 * queue must be able to mean "nothing to do", and a row saying there is nothing
 * to do in it is the same noise the queue exists to remove.
 *
 * The full list is built and then capped, so `total` is the honest count rather
 * than "five or fewer" — and because the cap is applied *after* the ordering
 * above, the items that make the figures wrong can never be the ones pushed
 * out.
 */
function attentionQueue(input: DashboardSummaryInput): {
  readonly items: readonly AttentionItem[];
  readonly total: number;
} {
  const items: AttentionItem[] = [];

  for (const batch of input.unclassified) {
    if (batch.count <= 0) continue;
    items.push({ kind: 'import_rows', batchId: batch.batchId, count: batch.count });
  }

  for (const contract of input.contractsMissingRate) {
    items.push({
      kind: 'fixed_income_rate',
      assetId: contract.assetId,
      assetCode: input.assetLabels.get(contract.assetId)?.code ?? null,
    });
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

  return { items: items.slice(0, ATTENTION_QUEUE_LIMIT), total: items.length };
}

/**
 * BR-020-27 / BR-011-16 — the figure, or the honest absence of one.
 *
 * `query.empty` is SPEC-011's own `isEmptyScope`: the scope holds nothing. It
 * is the right test rather than `value.isZero()`, because a portfolio *can*
 * hold positions that currently price to zero, and those are a figure — an
 * empty state would be a false claim in the other direction.
 *
 * **`hasHistory` is not "has imported", and the difference is BR-020-26.** That
 * rule exists because assets outside B3 custody have to be entered by hand, and
 * `/transactions/new` is how. A user who typed their whole ledger and has since
 * closed every position has no import and no holding — and telling *them* that
 * their *patrimônio* "aparece depois da primeira importação", with a button
 * offering to start one, denies years of their own data back to them. So three
 * signals count as history, none of which is the ledger (BR-016-05): a
 * committed import, any valuation snapshot ever written, or any row in the
 * position cache — including one closed to zero, which is precisely the trace
 * this case leaves.
 */
function portfolioOf(input: DashboardSummaryInput): DashboardPortfolio {
  if (!input.query.empty) {
    return {
      kind: 'valued',
      value: input.query.report.total.value,
      markers: valuationMarkers(input.query.report.groups.flatMap((group) => group.holdings)),
    };
  }
  const hasHistory =
    input.lastImportAt !== null || input.earliestSnapshot !== null || input.hasEverHeldAnything;
  return hasHistory ? { kind: 'no_holdings' } : { kind: 'onboarding' };
}

export function buildDashboardSummary(input: DashboardSummaryInput): DashboardSummary {
  const attention = attentionQueue(input);

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
    attention: attention.items,
    attentionTotal: attention.total,
  };
}
