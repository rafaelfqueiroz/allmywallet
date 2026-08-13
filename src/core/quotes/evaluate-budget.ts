import {
  consumptionPct,
  crossedAlertThreshold,
  projectedMonthEndUsage,
  scheduledBudget,
  totalUsed,
} from './budget';
import { chooseCadenceMinutes } from './cadence';
import type { BudgetUsage } from './ports';

/**
 * SPEC-008 BR-008-21/BR-008-22 — the pure decision at the heart of
 * `budget.check`: given this month's usage so far and the current
 * distinct-held-asset universe, what does an operator need to know, and
 * what cadence should the poller run at? No I/O — the handler
 * (`src/worker/handlers/budget.ts`) owns reading config, reading the
 * counter, and writing `runtime_state` (AR-01: core/ never touches either).
 */
export interface EvaluateBudgetInput {
  readonly usage: BudgetUsage;
  readonly monthlyQuota: number;
  readonly ondemandReservePct: number;
  readonly budgetAlertPct: number;
  readonly ladder: readonly number[];
  readonly distinctHeldAssetCount: number;
  readonly sessionMinutes: number;
  readonly tradingDaysInMonth: number;
  /** 1-based day-of-month "today" falls on, and how many days the month has — both from `Clock`. */
  readonly dayOfMonth: number;
  readonly daysInMonth: number;
}

export interface EvaluateBudgetResult {
  readonly consumptionPct: number;
  /** BR-008-21: crossing this raises an alert. */
  readonly alertCrossed: boolean;
  readonly projectedMonthEndUsage: number;
  /** BR-008-22: the cadence the ladder recommends for the current asset universe. */
  readonly recommendedCadenceMinutes: number;
}

export function evaluateBudget(input: EvaluateBudgetInput): EvaluateBudgetResult {
  return {
    consumptionPct: consumptionPct(input.usage, input.monthlyQuota),
    alertCrossed: crossedAlertThreshold(input.usage, input.monthlyQuota, input.budgetAlertPct),
    projectedMonthEndUsage: projectedMonthEndUsage(
      totalUsed(input.usage),
      input.dayOfMonth,
      input.daysInMonth,
    ),
    recommendedCadenceMinutes: chooseCadenceMinutes(
      input.ladder,
      input.distinctHeldAssetCount,
      scheduledBudget(input.monthlyQuota, input.ondemandReservePct),
      input.sessionMinutes,
      input.tradingDaysInMonth,
    ),
  };
}
