import { describe, expect, it } from 'vitest';
import { evaluateBudget } from './evaluate-budget';

/** SPEC-008 BR-008-21/22 — ties budget.ts + cadence.ts into one operator-facing decision. */
describe('evaluateBudget', () => {
  const baseInput = {
    monthlyQuota: 15_000,
    ondemandReservePct: 10,
    budgetAlertPct: 70,
    ladder: [30, 60, 120],
    sessionMinutes: 420,
    tradingDaysInMonth: 21,
    dayOfMonth: 10,
    daysInMonth: 30,
  };

  it('reports no alert and the fastest cadence when consumption and universe are both low', () => {
    const result = evaluateBudget({
      ...baseInput,
      usage: { scheduled: 1_000, ondemand: 100 },
      distinctHeldAssetCount: 20,
    });
    expect(result.alertCrossed).toBe(false);
    expect(result.recommendedCadenceMinutes).toBe(30);
    // Hand-computed: (1000+100)/15000*100 = 7.333...%
    expect(result.consumptionPct).toBeCloseTo((1_100 / 15_000) * 100, 10);
  });

  it('crosses the alert threshold and recommends a degraded cadence together', () => {
    const result = evaluateBudget({
      ...baseInput,
      usage: { scheduled: 10_500, ondemand: 0 }, // 70% of 15000
      distinctHeldAssetCount: 200, // outgrows even the slowest rung
    });
    expect(result.alertCrossed).toBe(true);
    expect(result.recommendedCadenceMinutes).toBe(120);
  });

  it('projects month-end usage independently of the cadence recommendation', () => {
    const result = evaluateBudget({
      ...baseInput,
      usage: { scheduled: 4_000, ondemand: 1_000 },
      distinctHeldAssetCount: 20,
      dayOfMonth: 10,
      daysInMonth: 30,
    });
    // Hand-computed: 5000/10*30 = 15000
    expect(result.projectedMonthEndUsage).toBe(15_000);
  });
});
