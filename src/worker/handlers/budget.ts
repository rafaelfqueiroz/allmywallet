import { db as globalDb, type Database } from '@/db/client';
import { logger } from '@/lib/logger';
import { setRuntimeState, clearRuntimeState, getRuntimeStateRow } from '@/config/runtime-state';
import { evaluateBudget } from '@/core/quotes/evaluate-budget';
import { computePollingSet } from '@/core/quotes/polling-set';
import { DrizzleHeldAssetsRepository } from '@/adapters/db/held-assets-repository';
import type {
  AssetCatalogPort,
  BudgetCounterPort,
  Clock,
  HeldAssetsPort,
  TradingCalendar,
} from '@/core/quotes/ports';
import {
  buildQuotesComposition,
  resolveOperatorCadenceMinutes,
  resolveQuoteBudgetConfig,
} from './composition';

/**
 * Same DI seam as `QuotesHandlerDeps` (quotes.ts) — real by default,
 * overridable for integration tests. `database` is what config resolution
 * (`resolveQuoteBudgetConfig`, `resolveOperatorCadenceMinutes`) and the
 * `runtime_state` read/write below run against — see quotes.ts's doc
 * comment on why it is separate from `budgetCounter`/`catalog`.
 */
export interface BudgetHandlerDeps {
  readonly database: Database;
  readonly clock: Clock;
  readonly calendar: TradingCalendar;
  readonly catalog: AssetCatalogPort;
  readonly budgetCounter: BudgetCounterPort;
  readonly heldAssets: HeldAssetsPort;
}

/**
 * SPEC-008 `budget.check` — BR-008-21/22/23. The pure decision lives in
 * `core/quotes/evaluate-budget.ts`; this handler owns the I/O: reading
 * config and the usage counter, and — the part that makes BR-008-22 real —
 * writing a cadence *adjustment* to `runtime_state`
 * (`@/config/runtime-state`), never to `config_overrides`
 * (`@/config/resolve`'s `setConfigValue`, the operator/user path).
 *
 * BR-008-23/DL-002-02: this is what makes a system degradation
 * distinguishable from an operator setting and survivable across a deploy —
 * `resolveConfig` (used by every other reader, including the poll handler)
 * checks `runtime_state` first, ahead of `config_overrides`, so the
 * degraded cadence takes effect immediately without a `config.set` audit
 * entry that would make it look intentional.
 */
export async function handleBudgetCheck(overrides?: Partial<BudgetHandlerDeps>): Promise<void> {
  const database = overrides?.database ?? globalDb;
  const composition = buildQuotesComposition(database);
  const clock = overrides?.clock ?? composition.clock;
  const calendar = overrides?.calendar ?? composition.calendar;
  const catalog = overrides?.catalog ?? composition.catalog;
  const budgetCounter = overrides?.budgetCounter ?? composition.budgetCounter;
  const heldAssets = overrides?.heldAssets ?? new DrizzleHeldAssetsRepository(database);
  const config = await resolveQuoteBudgetConfig(database);

  const yearMonth = clock.today().slice(0, 7);
  const usage = await budgetCounter.getUsage(yearMonth);

  const pollingSet = await computePollingSet({ heldAssets, catalog });

  const [year, month] = yearMonth.split('-');
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  const dayOfMonth = Number(clock.today().slice(8, 10));

  const evaluation = evaluateBudget({
    usage,
    monthlyQuota: config.monthlyQuota,
    ondemandReservePct: config.ondemandReservePct,
    budgetAlertPct: config.budgetAlertPct,
    ladder: config.degradationLadder,
    distinctHeldAssetCount: pollingSet.length,
    sessionMinutes: calendar.regularSessionMinutes(),
    tradingDaysInMonth: calendar.tradingDaysInMonth(yearMonth),
    dayOfMonth,
    daysInMonth,
  });

  if (evaluation.alertCrossed) {
    // BR-008-21: "operators alerted" — realised as a structured warning log,
    // the operator-facing channel this project has today (ARCHITECTURE §12,
    // Sentry/Uptime Kuma for M0-M4; no paging system exists to page yet).
    logger.warn(
      {
        queue: 'budget.check',
        consumptionPct: evaluation.consumptionPct,
        projectedMonthEndUsage: evaluation.projectedMonthEndUsage,
        monthlyQuota: config.monthlyQuota,
      },
      'SPEC-008 BR-008-21: quote budget alert threshold crossed',
    );
  }

  // BR-008-22/23: compared against the operator's own setting, bypassing any
  // active runtime override — this is what lets the handler tell "still
  // degraded" from "no longer needed" rather than chasing its own tail.
  const operatorCadenceMinutes = await resolveOperatorCadenceMinutes(database);
  const existingOverride = await getRuntimeStateRow(database, 'quotes.cadence_minutes');

  if (evaluation.recommendedCadenceMinutes > operatorCadenceMinutes) {
    if (existingOverride?.value !== evaluation.recommendedCadenceMinutes) {
      await setRuntimeState(
        database,
        'quotes.cadence_minutes',
        evaluation.recommendedCadenceMinutes,
        `BR-008-22: ${pollingSet.length} distinct held assets outgrow the operator-configured ${operatorCadenceMinutes}-minute cadence under the current quota; degraded automatically.`,
      );
      logger.warn(
        { queue: 'budget.check', newCadenceMinutes: evaluation.recommendedCadenceMinutes },
        'SPEC-008 BR-008-22: quote cadence degraded automatically',
      );
    }
  } else if (existingOverride) {
    // The universe (or usage) shrank back to where the operator's own
    // cadence is affordable again — clear the runtime override rather than
    // leaving a stale degradation in place forever.
    await clearRuntimeState(database, 'quotes.cadence_minutes');
    logger.info(
      { queue: 'budget.check' },
      'SPEC-008 BR-008-22: quote cadence degradation cleared — usage back within budget',
    );
  }
}
