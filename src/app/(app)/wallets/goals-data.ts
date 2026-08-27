import { asc, sql } from 'drizzle-orm';
import { BusinessDate, SystemClock } from '@/core/shared/clock';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import { AssetId, WalletId, type UserId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { err, ok, type Result } from '@/core/shared/result';
import { recordAchievement } from '@/core/goals/achievement';
import type { EarningsPeriod, GrowthBasis, WalletGoal } from '@/core/goals/goal';
import { earningsProgress, goalYears, type EarningsProgress } from '@/core/goals/earnings-progress';
import {
  firstAllocationDate,
  growthProgress,
  type GrowthProgress,
} from '@/core/goals/growth-progress';
import {
  GrowthUnavailable,
  type GoalAllocationEvent,
  type WalletHolding,
  type WalletValuation,
  type WalletValuationPort,
} from '@/core/goals/ports';
import type { EarningRecord } from '@/core/reporting/ports';
import { attributeAll, type EarningSlice } from '@/core/reporting/earnings/attribution';
import { FIXED_INCOME_CLASSES, valueHoldingsAt, type Holding } from '@/core/valuation/holdings';
import type { ListedValuationMode } from '@/core/valuation/listed';
import {
  loadValuationContextForAssets,
  type SnapshotDependencies,
} from '@/core/valuation/snapshot';
import { ValuationErrorCode, type ValuationContext } from '@/core/valuation/ports';
import type { Wallet } from '@/core/wallets/wallet';
import { B3TradingCalendar } from '@/adapters/calendar/b3-calendar';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzleFixedIncomeContractRepository } from '@/adapters/db/fixed-income-contract-repository';
import { DrizzleIndexSeriesRepository } from '@/adapters/db/index-series-repository';
import { DrizzleQuoteRepository } from '@/adapters/db/quote-repository';
import { DrizzleWalletGoalRepository } from '@/adapters/db/wallet-goal-repository';
import { DrizzleWalletRepository } from '@/adapters/db/wallet-repository';
import { DrizzleReportDataPort } from '@/app/(app)/reports/data';
import { buildGoalDeps } from '@/app/(app)/wallets/goals-composition';
import { db } from '@/db/client';
import { walletAllocationEvents } from '@/db/schema/wallets';
import { withTenant, type Tx } from '@/db/tenant';

/**
 * SPEC-019 — the read model behind `/wallets/[walletId]/goals`, in the shape
 * of `src/app/(app)/reports/data.ts`. AR-31/AR-33: the page (a Server
 * Component, owned by the UI agent) calls `loadGoalsView` directly; nothing
 * here decides anything `core/goals` hasn't already decided.
 */

// ---------------------------------------------------------------------------
// §1 — WalletValuationPort, the class-aware adapter
// ---------------------------------------------------------------------------

/**
 * BR-019-12 — prices a wallet's own holdings on a date, through
 * `valueHoldingsAt` and nothing else (the same function
 * `DrizzleReportDataPort.listValuedPositions` and every snapshot use), so this
 * chart's current-value line can never disagree with the Portfolio Value
 * chart on the next screen (SPEC-013 DL-013-06).
 *
 * **The one decision only this adapter can make**: what a `null`
 * `cost_basis_after` means, which depends on the asset's *class* —
 * `core/goals` has no other use for it and `GrowthUnavailable.COST_BASIS_NOT_RECORDED`'s
 * own doc comment (`core/goals/ports.ts`) is the specification this class
 * follows:
 *
 *  - **Listed and Tesouro Direto** price at quantity × an observed price; the
 *    wallet's own cost is not an input to that arithmetic at all, so a
 *    missing one costs nothing and `Money.zero()` is passed through as the
 *    average cost `valueHoldingsAt` expects but never uses for these classes.
 *  - **Fixed income** (`cdb`/`lci`/`lca`) is accrued from the holding's own
 *    cost basis (`core/valuation/accrual.ts`); with no cost there is nothing
 *    to accrue from, so the **whole date** is refused rather than drawn at a
 *    silently wrong figure.
 *
 * `ValuationContext` is supplied already loaded — see `buildValuationPort`
 * below for why it is loaded exactly once per render rather than once per
 * `valueOn` call.
 */
export class GoalWalletValuationAdapter implements WalletValuationPort {
  constructor(
    private readonly context: ValuationContext,
    /** The render's `asOf` — the one date `mode: 'current'` may ever apply to (BR-009-02). */
    private readonly today: BusinessDate,
  ) {}

  async valueOn(
    holdings: readonly WalletHolding[],
    date: BusinessDate,
  ): Promise<Result<WalletValuation, DomainError>> {
    // A wallet holding nothing on this date has nothing invested and nothing
    // to price — a valued zero, not an absence. `sumMoney([])` downstream
    // would agree; stated explicitly here so the loop below never has to
    // special-case an empty array.
    if (holdings.length === 0) return ok({ kind: 'valued', value: Money.zero(), estimated: false });

    const priced: Holding[] = [];
    // The assets whose cost this call had to invent — see the substitution
    // below, and the `needsAttention` check that keeps it honest.
    const costSubstituted = new Set<AssetId>();

    for (const holding of holdings) {
      const asset = this.context.assets.get(holding.assetId);
      if (asset === undefined) {
        // Mirrors `valueHoldingsAt`'s own guard. Unreachable in production —
        // `wallet_allocation_events.asset_id` is a foreign key into `assets`
        // — and surfaced as a `Result` rather than assumed for the same
        // reason `DrizzleReportDataPort.listValuedPositions` throws on it:
        // there is no honest class to price it as.
        return err(
          domainError(ValuationErrorCode.ASSET_NOT_FOUND, { assetId: holding.assetId, date }),
        );
      }

      if (holding.costBasisAfter === null) {
        if (FIXED_INCOME_CLASSES.has(asset.assetClass)) {
          // SPEC-019 BR-019-11: bank paper accrues from its own cost basis;
          // with none recorded there is nothing to accrue from, so the whole
          // date is unpriceable rather than drawn at a silently wrong figure.
          return ok({ kind: 'unpriceable', reason: GrowthUnavailable.COST_BASIS_NOT_RECORDED });
        }
        /**
         * Listed / Tesouro Direto: quantity × an **observed price** needs no
         * cost, so a missing one costs nothing — *provided a price is
         * actually found*.
         *
         * When none is, `valueListed` falls back to `averageCost × quantity`
         * (BR-009-13's cost floor), and the zero substituted here would make
         * that floor **zero** — a point drawn at R$ 0,00 and returned as a
         * real figure. That is the one shape this whole split must not
         * produce, so the substitution is recorded and checked against the
         * valuation's own `needsAttention` below rather than trusted.
         */
        costSubstituted.add(holding.assetId);
        priced.push({
          assetId: holding.assetId,
          quantity: holding.quantity,
          averageCost: Money.zero(),
        });
        continue;
      }

      priced.push({
        assetId: holding.assetId,
        quantity: holding.quantity,
        averageCost: holding.costBasisAfter.dividedBy(holding.quantity),
      });
    }

    // BR-009-02's guard rail: only the render's own `asOf`, when it is today,
    // may consult an intraday quote. Every other sampled date is history.
    const mode: ListedValuationMode = date === this.today ? 'current' : 'historical';
    const valued = valueHoldingsAt(this.context, priced, date, mode);
    if (!valued.ok) return valued;

    let total = Money.zero();
    let estimated = false;
    for (const position of valued.value) {
      /**
       * BR-009-13's cost fallback, met head on. A position that could not be
       * priced is valued at its cost basis and flagged; for a holding whose
       * cost this adapter *substituted with zero*, that fallback is not a
       * conservative figure but a fabricated one, and summing it would draw
       * the wallet as worth nothing on that date.
       *
       * Both halves of the failure are needed for it to bite — a substituted
       * cost **and** no price — which is exactly why neither alone is checked.
       * A holding with a real cost and no price still contributes its cost,
       * which is SPEC-009's deliberate floor, and rides out marked estimated.
       */
      if (position.needsAttention !== null && costSubstituted.has(position.assetId)) {
        return ok({ kind: 'unpriceable', reason: GrowthUnavailable.PRICE_UNAVAILABLE });
      }
      total = total.plus(position.value);
      // BR-019-12 / CR-1: one accrued or cost-floored component marks the point.
      if (position.estimated) estimated = true;
    }
    return ok({ kind: 'valued', value: total, estimated });
  }
}

/**
 * SPEC-011's `valuationDeps` (`src/app/(app)/reports/data.ts`), duplicated
 * rather than imported. That file is owned by nobody in this change and the
 * function is not exported — the same call this codebase already makes for
 * `AssetClass` (`core/quotes/ports.ts` vs. the schema's own CHECK): AR-01
 * forbids `core/` importing this shape, and here the reason is narrower still,
 * duplicating four lines rather than widening a report adapter's public
 * surface for a second, unrelated caller.
 */
function valuationDeps(tx: Tx, userId: UserId): Omit<SnapshotDependencies, 'snapshots'> {
  return {
    calendar: new B3TradingCalendar(),
    // AR-15: shared reference data, no tenant column — the pooled `db`.
    assets: new DrizzleAssetCatalogRepository(db),
    prices: new DrizzleQuoteRepository(db),
    indexSeries: new DrizzleIndexSeriesRepository(db),
    // `fixed_income_contracts` is tenant-scoped and FORCEd, so it must run
    // inside this render's own transaction (AR-11).
    contracts: new DrizzleFixedIncomeContractRepository(tx, userId),
  };
}

/**
 * Loads the `ValuationContext` **once per render**, sized to exactly the
 * assets this wallet has ever held — never per sampled date. `growthProgress`
 * calls `valueOn` roughly once per sampled point (~60 for a five-year monthly
 * series); a context load per call would turn that into ~120 queries per
 * asset per page, which is the mistake `WalletValuationPort`'s own doc
 * comment names.
 *
 * Skipped (an empty context, effectively free — see
 * `loadValuationContextForAssets`'s short-circuit on an empty id list) when no
 * goal on this wallet actually needs pricing: an `invested`-basis growth goal
 * never calls `deps.valuation` at all, and an earnings goal never receives one.
 */
async function buildValuationPort(
  tx: Tx,
  userId: UserId,
  goals: readonly WalletGoal[],
  events: readonly GoalAllocationEvent[],
  walletId: WalletId,
  asOf: BusinessDate,
): Promise<WalletValuationPort> {
  const needsValuation = goals.some(
    (goal) => goal.kind === 'growth' && goal.basis === 'current_value',
  );

  const assetIds = needsValuation
    ? [
        ...new Set(
          events.filter((event) => event.walletId === walletId).map((event) => event.assetId),
        ),
      ]
    : [];
  const from = needsValuation ? (firstAllocationDate(events, walletId) ?? asOf) : asOf;

  const context = await loadValuationContextForAssets(
    valuationDeps(tx, userId),
    assetIds,
    from,
    asOf,
  );
  return new GoalWalletValuationAdapter(context, asOf);
}

// ---------------------------------------------------------------------------
// Allocation events, with the wallet's own cost (SPEC-019 §1 / BR-010-22)
// ---------------------------------------------------------------------------

/**
 * SPEC-014 BR-014-12 + SPEC-019 BR-019-11 — the allocation log, oldest first,
 * with `cost_basis_after` alongside. `DrizzleReportDataPort.listAllocationEvents`
 * selects no such column (SPEC-014 has no use for it), so this is a second,
 * narrower query against the same table rather than an edit to that adapter.
 *
 * **Not filtered by wallet.** `core/goals`' fold functions
 * (`walletHoldingsOn`, `firstAllocationDate`, `goalYears`) and
 * `attributeAll`/`allocationAt` all take one wallet id and the *whole* event
 * log, exactly as `DrizzleReportDataPort.listAllocationEvents` hands
 * `attributeAll` every wallet's history — a payment's Unassigned remainder
 * cannot be computed from one wallet's slice of the log alone.
 *
 * Ordered `effectiveOn` ASC, `created_at` ASC: `core/goals` folds oldest-first
 * and relies on `created_at` as the tie-breaker for two changes on the same
 * business date, exactly as `core/reporting/earnings/attribution.ts` does.
 */
async function loadGoalAllocationEvents(
  tx: Tx,
  upTo: BusinessDate,
): Promise<readonly GoalAllocationEvent[]> {
  const rows = await tx
    .select({
      walletId: walletAllocationEvents.walletId,
      assetId: walletAllocationEvents.assetId,
      quantity: walletAllocationEvents.quantity,
      costBasisAfter: walletAllocationEvents.costBasisAfter,
      effectiveOn: walletAllocationEvents.effectiveOn,
    })
    .from(walletAllocationEvents)
    .where(sql`${walletAllocationEvents.effectiveOn} <= ${upTo}`)
    .orderBy(asc(walletAllocationEvents.effectiveOn), asc(walletAllocationEvents.createdAt));

  return rows.map((row) => ({
    walletId: WalletId.of(row.walletId),
    assetId: AssetId.of(row.assetId),
    quantity: row.quantity,
    costBasisAfter: row.costBasisAfter,
    effectiveOn: row.effectiveOn as BusinessDate,
  }));
}

// ---------------------------------------------------------------------------
// Earnings, attributed by SPEC-014 and never recomputed here (BR-019-14)
// ---------------------------------------------------------------------------

/**
 * `core/reporting/earnings/report.ts`'s own `scopedRecords`, duplicated for
 * the same reason `valuationDeps` above is: that function is module-private
 * and this is a three-line fold, not a seam worth widening a report's public
 * surface for. Maps each slice back onto an `EarningRecord` carrying the
 * **slice's** amount — the part of the payment this wallet actually received
 * — never the whole payment's.
 */
function scopedGoalEarnings(slices: readonly EarningSlice[]): readonly EarningRecord[] {
  return slices.map((slice) => ({ ...slice.earning, amount: slice.amount }));
}

/**
 * BR-019-22: the requested year when it is one the wallet actually offers,
 * else the current year (so a goal page a user has never visited opens on
 * "now"), else — for a wallet whose history is entirely in the past, or
 * entirely in a future nobody has reached yet — the latest year available,
 * which for an all-past wallet is simply its most recent one.
 */
function resolveSelectedYear(
  years: readonly number[],
  requested: number | null,
  currentYear: number,
): number {
  if (requested !== null && years.includes(requested)) return requested;
  if (years.includes(currentYear)) return currentYear;
  return years.at(-1) ?? currentYear;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface GoalView {
  readonly goal: WalletGoal;
  readonly growth: GrowthProgress | null;
  readonly earnings: EarningsProgress | null;
}

export interface GoalsView {
  readonly wallet: Wallet;
  readonly goals: readonly GoalView[];
  /** BR-019-22 — only years the wallet existed and had allocations, ascending. */
  readonly years: readonly number[];
  /** The year the earnings charts are drawn for. See `resolveSelectedYear` for the fallback rule. */
  readonly selectedYear: number;
  readonly asOf: BusinessDate;
}

/**
 * SPEC-019 — assembles one wallet's goals page.
 *
 * One `withTenant` transaction for the whole render (AR-11), in the shape of
 * `withReportPort` (`src/app/(app)/reports/data.ts`): RLS context is set
 * exactly once and every figure — the wallet, its goals, the allocation
 * history, the attributed earnings and the achievement write below — comes
 * from a single consistent view of the tenant's data.
 *
 * Returns `null` when the wallet does not exist for this tenant, rather than
 * throwing: RLS already makes another tenant's wallet id indistinguishable
 * from one that was never created, and the route (owned by the UI agent)
 * renders that as a 404.
 */
export async function loadGoalsView(
  userId: UserId,
  walletId: WalletId,
  year: number | null,
): Promise<GoalsView | null> {
  const clock = new SystemClock();
  // AR-29: today in São Paulo, not the reader's clock.
  const asOf = clock.today();

  return withTenant(
    userId,
    async (tx) => {
      const wallet = await new DrizzleWalletRepository(tx, userId).findById(walletId);
      if (wallet === null) return null;

      const goalRepo = new DrizzleWalletGoalRepository(tx, userId);
      const goals = await goalRepo.listForWallet(walletId);

      const events = await loadGoalAllocationEvents(tx, asOf);

      const years = goalYears(events, walletId, asOf);
      const currentYear = Number(asOf.slice(0, 4));
      const selectedYear = resolveSelectedYear(years, year, currentYear);

      // BR-019-14: no income is computed here — it is read through SPEC-014's
      // own attribution and merely scoped to this wallet and this year.
      const from = BusinessDate.of(`${selectedYear}-01-01`);
      const to = BusinessDate.of(`${selectedYear}-12-31`);
      const reportPort = new DrizzleReportDataPort(tx, userId, clock);
      const earnings = await reportPort.listEarnings(from, to);
      const slices = attributeAll(earnings, events);
      const walletEarnings = scopedGoalEarnings(
        slices.filter((slice) => slice.walletId === walletId),
      );

      const valuation = await buildValuationPort(tx, userId, goals, events, walletId, asOf);
      const deps = buildGoalDeps(tx, userId, { valuation, clock });

      const views: GoalView[] = [];
      for (const goal of goals) {
        if (goal.kind === 'growth') {
          const progress = await growthProgress(valuation, goal, events, asOf);
          if (!progress.ok) {
            // `NOT_A_GROWTH_GOAL` cannot fire — `goal.kind` was just checked.
            // The only other failure is the valuation's own `ASSET_NOT_FOUND`,
            // unreachable in production for the same reason
            // `DrizzleReportDataPort.listValuedPositions` throws on it rather
            // than degrading: there is no honest fallback for a row a foreign
            // key should have prevented.
            throw new Error(`goal growth progress failed: ${progress.error.code}`);
          }

          // BR-019-23/24/25 — evaluated on every read. `markAchieved` is
          // `WHERE achieved_on IS NULL` (see the repository's own comment), so
          // the write and the send are idempotent under any number of
          // renders: the *n*-th page view after achievement finds the marker
          // already set and does nothing, which is what makes "exactly one"
          // email a property of that one SQL statement rather than of how
          // often this page happens to be opened.
          const outcome = await recordAchievement(
            deps,
            userId,
            goal.id,
            progress.value.achieved,
            // BR-019-24: the date the burn-up crossed the amount. For a wallet
            // whose history was imported this afternoon, that is years ago —
            // and the clock would have said today, permanently.
            progress.value.achievedOn,
          );
          const resolvedGoal = outcome.ok
            ? { ...goal, achievedOn: outcome.value.achievedOn }
            : goal;

          views.push({ goal: resolvedGoal, growth: progress.value, earnings: null });
        } else {
          const progress = earningsProgress(goal, walletEarnings, selectedYear, asOf);
          if (!progress.ok) {
            // `NOT_AN_EARNINGS_GOAL` cannot fire for the same reason above.
            throw new Error(`goal earnings progress failed: ${progress.error.code}`);
          }

          /**
           * BR-019-23 — an earnings goal is achieved **within the period it
           * names**, and that period is the one running now, not whichever
           * one the reader happens to be looking at.
           *
           * The year selector is a browsing control (BR-019-22). Feeding the
           * displayed year's `achieved` into `recordAchievement` would mean
           * opening the dropdown and picking 2023 permanently marks the goal
           * — BR-019-26 says the marker is never cleared — stamps it with
           * today's date, and sends the achievement email, for income
           * received three years ago. The user asked a question about the
           * past and the product wrote to the database and mailed them.
           *
           * So the write is gated on the chart being about the current year.
           * Nothing is lost by deferring: the current year is what the page
           * defaults to, so the next ordinary visit records it.
           */
          const outcome =
            selectedYear === currentYear
              ? await recordAchievement(
                  deps,
                  userId,
                  goal.id,
                  progress.value.achieved,
                  // BR-019-24: the pay date that carried it over, to the day.
                  progress.value.achievedOn,
                )
              : null;
          const resolvedGoal =
            outcome !== null && outcome.ok
              ? { ...goal, achievedOn: outcome.value.achievedOn }
              : goal;

          views.push({ goal: resolvedGoal, growth: null, earnings: progress.value });
        }
      }

      return { wallet, goals: views, years, selectedYear, asOf };
    },
    db,
  );
}

// Re-exported so a caller can narrow a `GoalKind`/`GrowthBasis`/`EarningsPeriod`
// without reaching past this module into `core/goals/goal.ts` for a type this
// file's own signatures already mention.
export type { GrowthBasis, EarningsPeriod };
