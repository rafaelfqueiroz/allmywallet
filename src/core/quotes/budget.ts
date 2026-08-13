import type { BudgetUsage } from './ports';

/**
 * SPEC-008 — pure budget arithmetic over call *counts*, not money, so plain
 * JS numbers are correct here (AR-06 governs monetary amounts; a request
 * count is never one). No I/O: the worker handlers own reading
 * `BudgetCounterPort` and `runtime_state`; this module only decides.
 */

/** BR-008-19: the whole free-tier ceiling in one number — one ticker per call. */
export const REQUESTS_PER_CALL = 1;

/**
 * BR-008-20: the reserve is a partition of the monthly quota, not a soft
 * target — `Math.floor` here (never `Math.round`, banned by lint per AR-09's
 * spirit even outside money) means the scheduled share is never rounded *up*
 * at the reserve's expense.
 */
export function scheduledBudget(monthlyQuota: number, ondemandReservePct: number): number {
  return Math.floor((monthlyQuota * (100 - ondemandReservePct)) / 100);
}

export function ondemandReserve(monthlyQuota: number, ondemandReservePct: number): number {
  return monthlyQuota - scheduledBudget(monthlyQuota, ondemandReservePct);
}

/** BR-008-20: scheduled polling can never be starved by a burst of on-demand searching. */
export function hasScheduledBudget(
  usage: BudgetUsage,
  monthlyQuota: number,
  ondemandReservePct: number,
): boolean {
  return usage.scheduled < scheduledBudget(monthlyQuota, ondemandReservePct);
}

/** BR-008-20: on-demand spend is capped at the reserve and cannot dip into the scheduled share. */
export function hasOndemandBudget(
  usage: BudgetUsage,
  monthlyQuota: number,
  ondemandReservePct: number,
): boolean {
  return usage.ondemand < ondemandReserve(monthlyQuota, ondemandReservePct);
}

export function totalUsed(usage: BudgetUsage): number {
  return usage.scheduled + usage.ondemand;
}

/** BR-008-21: consumption tracked continuously as a percent of the monthly quota. */
export function consumptionPct(usage: BudgetUsage, monthlyQuota: number): number {
  if (monthlyQuota <= 0) return 0;
  return (totalUsed(usage) / monthlyQuota) * 100;
}

/** BR-008-21: crossing the alert threshold (default 70%) raises an alert. */
export function crossedAlertThreshold(
  usage: BudgetUsage,
  monthlyQuota: number,
  budgetAlertPct: number,
): boolean {
  return consumptionPct(usage, monthlyQuota) >= budgetAlertPct;
}

/**
 * BR-008-21: "projected month-end burn" — a straight-line extrapolation from
 * consumption so far this month. `dayOfMonth`/`daysInMonth` are 1-based
 * calendar positions the caller reads off `Clock`. `Math.ceil` so the
 * projection is always the conservative (higher) reading, matching BR-008-22's
 * "degrade before exhausting" bias.
 */
export function projectedMonthEndUsage(
  consumedSoFar: number,
  dayOfMonth: number,
  daysInMonth: number,
): number {
  if (dayOfMonth <= 0 || daysInMonth <= 0) {
    throw new RangeError('projectedMonthEndUsage: dayOfMonth and daysInMonth must be positive');
  }
  return Math.ceil((consumedSoFar / dayOfMonth) * daysInMonth);
}
